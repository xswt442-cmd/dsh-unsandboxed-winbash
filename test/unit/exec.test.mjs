// Pure unit tests for the Git Bash executor: PATH composition, environment
// scrubbing, Git-root derivation, the bounded output collector and the tree-kill
// policy.
//
// Nothing here spawns a process, and nothing here resolves against a real Git for
// Windows installation: the runner and the OS seams are fakes injected through
// `deps`, and the bash paths are synthetic. What the suite does assume is Windows
// path semantics, because that is the only platform this plugin loads on. The
// spawning half is test/e2e/exec.test.mjs, and test/unit/layout.test.mjs guards
// the split.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  buildEnvironment,
  candidateGitBashPaths,
  composePath,
  createCollector,
  gitRootOf,
  installChildTeardown,
  resolveGitBashPath,
  spawnBash,
  taskkillTree,
  teardownSignals,
  terminateLiveChildren
} from '../../lib/tool/exec.js'

const B = String.fromCharCode(92)
// Synthetic Git for Windows locations: shape only, never probed.
const CANDIDATES = [
  'C:' + B + 'Program Files' + B + 'Git' + B + 'usr' + B + 'bin' + B + 'bash.exe',
  'C:' + B + 'Program Files' + B + 'Git' + B + 'bin' + B + 'bash.exe',
  'C:' + B + 'Program Files (x86)' + B + 'Git' + B + 'usr' + B + 'bin' + B + 'bash.exe'
]
const GIT_ROOT = 'C:' + B + 'Program Files' + B + 'Git'
const GIT_BASH = CANDIDATES[0]

const BASE_CONFIG = {
  enableRunInBackground: true,
  bashPath: GIT_BASH,
  gitPathPrefix: true,
  extraPath: '',
  timeoutMs: 120000,
  maxTimeoutMs: 600000,
  maxOutputBytes: 64000,
  maxSpillBytes: 64 * 1024 * 1024,
  graceMs: 3000,
  drainMs: 250
}
// A kill-path test must not wait out the production grace period, and a fake child
// has no real streams to drain, so both timers run at test speed.
const FAST_CONFIG = { ...BASE_CONFIG, graceMs: 20, drainMs: 5 }

const request = (command, extra = {}) => ({
  bashPath: GIT_BASH,
  command,
  dshEnv: { DSH_SHELL: '1' },
  ...extra
})

/** Deps that keep a run off the real environment and off the real install. */
const isolated = {
  scrubbedParentEnv: () => ({ PATH: 'C:' + B + 'Windows' }),
  exists: () => true,
  resolveBashPath: (path) => path
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait for a condition without blocking the loop; returns whether it happened. */
async function waitedFor(condition, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (condition()) return true
    await sleep(5)
  }
  return Boolean(condition())
}

/**
 * A child process shaped like the `child_process` one the executor uses: an event
 * emitter with two already-exhausted streams, so a run settles on `exit` exactly
 * the way a real one does and nothing has to be timed.
 */
class FakeChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.killed = []
    this.stdout = fakeStream()
    this.stderr = fakeStream()
  }
  kill(signal) {
    this.killed.push(signal)
    return true
  }
}
function fakeStream() {
  const stream = new EventEmitter()
  stream.readableEnded = true
  stream.destroyed = false
  stream.destroy = () => {
    stream.destroyed = true
  }
  stream.off = stream.removeListener.bind(stream)
  return stream
}

/**
 * A process stand-in for the teardown-hook tests.
 *
 * It records what the code *decided*, which is the only thing the unit layer may
 * claim from it: which watchers exist, whether the reaper was called, and which
 * name the code chose to end the process with. It says nothing about what a real
 * signal would do to a real host — that half lives in test/e2e/, because a fake
 * cannot make an undeliverable signal deliverable.
 */
class FakeProcess extends EventEmitter {
  constructor() {
    super()
    this.pid = 999999
    this.terminated = []
  }
  kill(pid, signal) {
    this.terminated.push({
      pid,
      signal
    })
    return true
  }
}

/**
 * Start a run against a fake spawn and record every reaper call it makes, so the
 * negative cases ("nothing was killed") are assertable rather than implied.
 *
 * `record` is the same recorder handed to a later `terminateLiveChildren` or
 * `installChildTeardown` call, so one list shows every reaper the run ever saw.
 */
function harness(child, { config = FAST_CONFIG, platform = 'win32', spawn } = {}) {
  const calls = []
  const record = (command, args, options) => calls.push({
    command,
    args,
    options
  })
  const run = spawnBash(request('true'), config, undefined, {
    ...isolated,
    platform,
    spawn: spawn ?? (() => child),
    spawnSync: record
  })
  return {
    run,
    calls,
    record,
    taskkills: () => calls.filter((call) => call.command === "taskkill"),
    reapedPids: () => calls.filter((call) => call.command === "taskkill").map((call) => call.args[1]),
    settle: async (exitCode = 0, signal = null) => {
      child.emit('exit', exitCode, signal)
      await run.closed
    }
  }
}

//#region discovery
test('bash discovery never falls back to a PATH lookup', () => {
  // A bare `bash` on Windows resolves to the WSL shim (C:\Windows\System32\bash.exe),
  // which is a different shell; the resolver never returns one, and an explicit path
  // that does not exist is an error rather than a silent fallback.
  assert.throws(() => resolveGitBashPath('C:' + B + 'nope' + B + 'bash.exe', process.env), /does not exist/)
  assert.throws(() => resolveGitBashPath('', {}, () => false), /never falls back to PATH/)
})

test('discovery prefers the real MSYS2 bash over the wrapper', () => {
  // The existence probe is injected, so the preference order is asserted on any
  // machine, including one with no Git for Windows installed.
  const env = {
    ProgramFiles: 'C:' + B + 'Program Files',
    'ProgramFiles(x86)': 'C:' + B + 'Program Files (x86)'
  }
  const wrapperOnly = new Set([CANDIDATES[2]])
  assert.equal(resolveGitBashPath('', env, (path) => wrapperOnly.has(path)), CANDIDATES[2])
  const both = new Set([
    CANDIDATES[0],
    CANDIDATES[1]
  ])
  assert.equal(resolveGitBashPath('', env, (path) => both.has(path)), CANDIDATES[0], 'usr\\bin is probed first')
})

test('a configured bashPath wins, and a real file is accepted as-is', () => {
  // An explicit path is used untouched, and only when it is really there: the same
  // probe the auto-discovery path gets.
  assert.equal(resolveGitBashPath(CANDIDATES[1], {}, () => true), CANDIDATES[1])
  // The only probe against the real file system in this suite, on a file that
  // exists wherever node itself exists.
  assert.equal(resolveGitBashPath(process.execPath), process.execPath)
})

test('discovery falls back to real Windows paths when the environment omits ProgramFiles', () => {
  // Fallback literals are easy to over-escape: `"C:\Program Files"` evaluates to
  // `C:Program Files`, which is not a directory, so a host whose environment lacks
  // ProgramFiles would probe nowhere. Assert the composed path, not the source.
  const fallback = candidateGitBashPaths({})
  assert.equal(fallback[0], GIT_ROOT + B + 'usr' + B + 'bin' + B + 'bash.exe')
  assert.equal(fallback[1], GIT_ROOT + B + 'bin' + B + 'bash.exe')

  const supplied = candidateGitBashPaths({
    ProgramFiles: 'D:' + B + 'PF',
    'ProgramFiles(x86)': 'D:' + B + 'PF86',
    LOCALAPPDATA: 'D:' + B + 'LA'
  })
  assert.equal(supplied[0], 'D:' + B + 'PF' + B + 'Git' + B + 'usr' + B + 'bin' + B + 'bash.exe', 'usr\\bin is preferred over the wrapper')
  assert.equal(supplied[2], 'D:' + B + 'LA' + B + 'Programs' + B + 'Git' + B + 'usr' + B + 'bin' + B + 'bash.exe')
  assert.equal(supplied[4], 'D:' + B + 'PF86' + B + 'Git' + B + 'usr' + B + 'bin' + B + 'bash.exe')
})

test('gitRootOf derives the install root from both layouts', () => {
  assert.equal(gitRootOf(CANDIDATES[0]), GIT_ROOT)
  assert.equal(gitRootOf(CANDIDATES[1]), GIT_ROOT)
  assert.equal(gitRootOf(CANDIDATES[2]), 'C:' + B + 'Program Files (x86)' + B + 'Git')
})

test('composePath places extra entries first and keeps the host PATH at the tail', () => {
  const composed = composePath({
    inherited: 'C:' + B + 'Windows;C:' + B + 'Windows' + B + 'System32;C:' + B + 'tools',
    bashPath: GIT_BASH,
    gitPathPrefix: true,
    extraPath: 'D:' + B + 'extra',
    exists: () => true
  })
  assert.ok(composed.startsWith('D:' + B + 'extra;'), composed)
  assert.ok(composed.indexOf('usr' + B + 'bin') < composed.indexOf('C:' + B + 'Windows;'), composed)
  assert.ok(composed.endsWith('C:' + B + 'Windows;C:' + B + 'Windows' + B + 'System32;C:' + B + 'tools'), composed)

  const deduped = composePath({
    inherited: 'C:' + B + 'tools;C:' + B + 'Tools;C:' + B + 'tools' + B,
    bashPath: GIT_BASH,
    gitPathPrefix: false,
    extraPath: '',
    exists: () => true
  })
  assert.equal(deduped, 'C:' + B + 'tools', 'de-duplication is case-insensitive')

  const untouched = composePath({
    inherited: 'C:' + B + 'Windows',
    bashPath: GIT_BASH,
    gitPathPrefix: false,
    extraPath: '',
    exists: () => true
  })
  assert.equal(untouched, 'C:' + B + 'Windows')

  const nothingInstalled = composePath({
    inherited: 'C:' + B + 'Windows',
    bashPath: GIT_BASH,
    gitPathPrefix: true,
    extraPath: '',
    exists: () => false
  })
  assert.equal(nothingInstalled, 'C:' + B + 'Windows', 'a Git directory that is not there is not added either')
})
//#endregion
//#region environment
test('buildEnvironment repairs PATH from the resolved Git install', () => {
  const env = buildEnvironment(request('true'), BASE_CONFIG, {
    ...isolated,
    scrubbedParentEnv: () => ({
      PATH: 'C:' + B + 'Windows',
      SOME_API_KEY: 'never forwarded'
    })
  })
  assert.equal(env.PATH, [
    GIT_ROOT + B + 'usr' + B + 'bin',
    GIT_ROOT + B + 'mingw64' + B + 'bin',
    GIT_ROOT + B + 'cmd',
    'C:' + B + 'Windows'
  ].join(';'))
  assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH').length, 1)
  assert.equal(env.NO_COLOR, '1')
  assert.equal(env.TERM, 'dumb')
  assert.equal(env.DSH_SHELL, '1', 'trusted DSH_* facts are forwarded')
})

test('buildEnvironment scrubs credential-shaped names through the real scrubber', () => {
  // Real `scrubbedParentEnv`, and no PATH repair, so the assertion holds on a host
  // with no Git for Windows: what is under test is the name filter alone.
  const env = buildEnvironment(request('true'), { ...BASE_CONFIG, gitPathPrefix: false, extraPath: '' })
  assert.ok(Object.keys(env).every((key) => !/KEY|PASSWORD|SECRET|TOKEN/i.test(key)), JSON.stringify(Object.keys(env)))
  assert.equal(env.NO_COLOR, '1')
  assert.equal(env.DSH_SHELL, '1')
})

test('an override replaces every inherited casing of the same name', () => {
  const env = buildEnvironment(request('true'), { ...BASE_CONFIG, gitPathPrefix: false }, {
    ...isolated,
    scrubbedParentEnv: () => ({
      no_color: '0',
      PATH: 'C:' + B + 'Windows'
    })
  })
  assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === 'NO_COLOR').length, 1)
  assert.equal(env.NO_COLOR, '1', 'the override wins over the inherited casing')
})
//#endregion
//#region spawner
test('the spawner keeps windowsHide on: that is the whole popup fix', async () => {
  let captured
  const child = new FakeChild(4242)
  const run = harness(child, {
    spawn: (file, args, options) => {
      captured = { file, args, options }
      return child
    }
  })
  assert.equal(captured.options.windowsHide, true)
  assert.equal(captured.file, GIT_BASH)
  assert.deepEqual(captured.args, ['-c', 'true'])
  assert.deepEqual(captured.options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.deepEqual(run.reapedPids(), [], 'spawning alone kills nothing')
  await run.settle()
})

test('a run settles on exit and stops counting as live', async () => {
  // `close` never fires for a killed child whose grandchild inherited the pipes, so
  // the executor settles on `exit`; this asserts the bookkeeping that follows: the
  // child leaves the live set, and a later host teardown has nothing to reap.
  const child = new FakeChild(4243)
  const run = harness(child)
  await run.settle(0, null)
  assert.deepEqual(await run.run.closed, {
    exitCode: 0,
    signal: null
  })
  assert.deepEqual(run.reapedPids(), [], 'a command that ran to completion is never tree-killed')
  terminateLiveChildren({
    platform: 'win32',
    spawnSync: () => assert.fail('a settled child must not be reaped')
  })
})
//#endregion
//#region tree kill
test('an interrupted run reaps exactly its own tree, with the documented arguments', async () => {
  const child = new FakeChild(4244)
  const run = harness(child)
  run.run.kill()
  assert.deepEqual(run.reapedPids(), ['4244'], 'the reaped pid is the direct child pid')
  assert.deepEqual(run.taskkills()[0].args, ['/PID', '4244', '/T', '/F'], '/T walks the tree, /F forces')
  assert.equal(run.taskkills().length, 1, 'one reaper call per kill')
  assert.deepEqual(child.killed, [], 'no SIGKILL while the grace window is still open')
  await run.settle(null, 'SIGKILL')
})

test('taskkillTree hides the console the reaper would otherwise allocate', () => {
  const calls = []
  taskkillTree(4321, {
    spawnSync: (command, args, options) => calls.push({
      command,
      args,
      options
    })
  })
  assert.deepEqual(calls, [{
    command: 'taskkill',
    args: ['/PID', '4321', '/T', '/F'],
    options: {
      stdio: 'ignore',
      windowsHide: true
    }
  }])
})

test('taskkillTree swallows a reaper failure: a dead child is not a tool error', () => {
  assert.doesNotThrow(() => taskkillTree(1, {
    spawnSync: () => {
      throw new Error('taskkill unavailable')
    }
  }))
})

test('SIGKILL escalation arrives only when the tree outlives the grace window', async () => {
  const child = new FakeChild(4245)
  const run = harness(child)
  run.run.kill()
  assert.ok(await waitedFor(() => child.killed.includes('SIGKILL')), 'the escalation fired after graceMs')
  assert.deepEqual(child.killed, ['SIGKILL'])
  await run.settle(null, 'SIGKILL')
})

test('a settled run has its escalation timer cleared, so nobody is killed after the fact', async () => {
  const child = new FakeChild(4246)
  const run = harness(child)
  run.run.kill()
  await run.settle(0, null)
  // Proving a timer did NOT fire means outlasting it; 4x the 20ms grace window is
  // the minimum that says anything, and it does not depend on the machine.
  await sleep(FAST_CONFIG.graceMs * 4)
  assert.deepEqual(child.killed, [], 'the SIGKILL escalation was cleared when the run settled')
})

test('a child that never got a pid is skipped, not reaped as somebody else', async () => {
  // A failed spawn carries `pid === undefined`; reaping that would be a
  // `taskkill /PID undefined` at best and the wrong process at worst.
  const child = new FakeChild(undefined)
  const run = harness(child)
  terminateLiveChildren({
    platform: 'win32',
    spawnSync: run.record
  })
  assert.deepEqual(run.reapedPids(), [])
  child.emit('error', new Error('spawn failed'))
  const outcome = await run.run.closed
  assert.ok(outcome.spawnError instanceof Error, 'a spawn failure settles as an error outcome')
})

test('teardown on a non-Windows platform kills the child directly, never through taskkill', async () => {
  const child = new FakeChild(4250)
  const run = harness(child, { platform: 'linux' })
  terminateLiveChildren({
    platform: 'linux',
    spawnSync: () => assert.fail('taskkill is the Windows reaper only')
  })
  assert.deepEqual(child.killed, ['SIGKILL'])
  await run.settle(null, 'SIGKILL')
})
//#endregion
//#region host teardown hooks
test('a host exit reaps the children that are still live', async () => {
  const child = new FakeChild(4247)
  const run = harness(child)
  const host = new FakeProcess()
  const dispose = installChildTeardown(host, {
    platform: 'win32',
    spawnSync: run.record
  })
  host.emit('exit', 0)
  assert.deepEqual(run.reapedPids(), ['4247'], 'the exit hook reaped the live child')
  dispose()
  host.emit('exit', 0)
  assert.equal(run.taskkills().length, 1, 'after dispose no hook is left')
  await run.settle(null, 'SIGKILL')
})

test('the watched signals are the ones the platform can deliver', () => {
  // Windows delivers SIGINT for Ctrl+C and SIGBREAK for Ctrl+Break, and never
  // delivers SIGTERM at all; off Windows those two names swap. A watcher for a
  // signal that can never arrive is a handler nobody can call, so which names get a
  // watcher is the policy, and this pins it for both platforms.
  assert.deepEqual(teardownSignals('win32'), ['SIGINT', 'SIGBREAK'])
  assert.deepEqual(teardownSignals('linux'), ['SIGINT', 'SIGTERM'])
  for (const [platform, watched] of [
    ['win32', ['SIGINT', 'SIGBREAK']],
    ['linux', ['SIGINT', 'SIGTERM']]
  ]) {
    const host = new FakeProcess()
    const dispose = installChildTeardown(host, {
      platform,
      spawnSync: () => {}
    })
    const names = ['SIGINT', 'SIGTERM', 'SIGBREAK']
    assert.deepEqual(names.map((name) => host.listenerCount(name)), names.map((name) => watched.includes(name) ? 1 : 0), `${platform} watches exactly ${watched.join(', ')}`)
    assert.equal(host.listenerCount('exit'), 1)
    dispose()
    assert.deepEqual(['exit', ...names].map((name) => host.listenerCount(name)), [0, 0, 0, 0], 'dispose leaves no watcher behind')
  }
})

test('a sole-listener signal on Windows reaps the tree and ends the process by a name node accepts', async () => {
  const child = new FakeChild(4248)
  const run = harness(child)
  const host = new FakeProcess()
  const dispose = installChildTeardown(host, {
    platform: 'win32',
    spawnSync: run.record
  })
  for (const signal of [
    'SIGINT',
    'SIGBREAK'
  ]) {
    host.emit(signal)
    assert.equal(run.reapedPids().at(-1), '4248', `the ${signal} path reaps the live tree`)
    assert.equal(host.listenerCount(signal), 0, 'the handler removed itself, so it cannot run twice')
    // The name is the decision under test, not the platform's reaction: on Windows
    // `process.kill` cannot hand SIGINT or SIGBREAK back — SIGINT, SIGTERM and
    // SIGKILL all mean one unconditional termination, and SIGBREAK is rejected — so
    // the code ends the process through the name that cannot be rejected.
    assert.deepEqual(host.terminated.at(-1), {
      pid: host.pid,
      signal: 'SIGKILL'
    }, `the ${signal} path ends the host with the terminating name`)
  }
  assert.deepEqual(host.terminated.map((call) => call.signal), ['SIGKILL', 'SIGKILL'], 'no undeliverable name is ever used to end the process')
  dispose()
  await run.settle(null, 'SIGKILL')
})

test('off Windows the intercepted signal is handed back under its own name', async () => {
  // There a re-raise is a real signal: with the plugin's watcher removed, node
  // applies its default action, so the name that arrived is the name to send.
  const child = new FakeChild(4251)
  const run = harness(child, { platform: 'linux' })
  const host = new FakeProcess()
  const dispose = installChildTeardown(host, {
    platform: 'linux',
    spawnSync: () => assert.fail('taskkill is the Windows reaper only')
  })
  for (const signal of [
    'SIGINT',
    'SIGTERM'
  ]) {
    host.emit(signal)
    assert.equal(host.listenerCount(signal), 0, 'the handler removed itself')
    assert.deepEqual(host.terminated.at(-1), {
      pid: host.pid,
      signal
    })
  }
  assert.deepEqual(child.killed, ['SIGKILL', 'SIGKILL'], 'a posix teardown kills the child directly')
  dispose()
  await run.settle(null, 'SIGKILL')
})

test('a signal the host already handles is left entirely to the host', async () => {
  // This plugin must not decide when dsh shuts down. With another listener present
  // it does nothing at all, and the host's own shutdown path ends in `exit`, where
  // the hook above does the reaping.
  const child = new FakeChild(4249)
  const run = harness(child)
  const host = new FakeProcess()
  let hostHandlerRan = false
  host.on('SIGINT', () => {
    hostHandlerRan = true
  })
  const dispose = installChildTeardown(host, {
    platform: 'win32',
    spawnSync: () => assert.fail('no tree may be reaped while the host owns the signal')
  })
  host.emit('SIGINT')
  assert.equal(hostHandlerRan, true, 'the host handler still runs')
  assert.deepEqual(run.reapedPids(), [])
  assert.deepEqual(host.terminated, [], 'the host is not ended by this plugin')
  assert.equal(host.listenerCount('SIGINT'), 2, 'and the plugin keeps watching, because the host is still shutting down')
  dispose()
  await run.settle(0, null)
})
//#endregion
//#region collector and deadlines
test('the collector keeps a bounded multi-byte-safe tail and spills the rest', () => {
  const collector = createCollector({ maxBytes: 64, maxSpillBytes: 1 << 20, streamName: 'stdout' })
  for (let index = 0; index < 10; index += 1) {
    collector.push(Buffer.from(`chunk-${index}-${'x'.repeat(20)}\n`, 'utf8'))
  }
  const settled = collector.finish()
  assert.equal(settled.truncated, true)
  assert.ok(Buffer.byteLength(settled.text, 'utf8') <= 64 + 40)
  assert.ok(settled.text.includes('chunk-9'), 'the tail is what survives')
  assert.equal(typeof settled.spillPath, 'string')
  assert.ok(readFileSync(settled.spillPath, 'utf8').includes('chunk-0'))
  assert.ok(readFileSync(settled.spillPath, 'utf8').includes('chunk-9'))

  const multibyte = createCollector({ maxBytes: 16, maxSpillBytes: 1 << 20, streamName: 'stdout' })
  multibyte.push(Buffer.from('中文中文中文中文中文中文', 'utf8'))
  const mbSettled = multibyte.finish()
  assert.ok(!mbSettled.text.includes('\uFFFD'), 'a trim never leaves a replacement character')
  assert.ok('中文中文中文中文中文中文'.endsWith(mbSettled.text))

  const huge = createCollector({ maxBytes: 4096, maxSpillBytes: 1 << 20, streamName: 'stdout' })
  for (let index = 0; index < 400; index += 1) huge.push(Buffer.from(`行${index}-${'宽'.repeat(40)}\n`, 'utf8'))
  const hugeSettled = huge.finish()
  assert.ok(hugeSettled.text.includes('行399-'))
  assert.ok(Buffer.byteLength(hugeSettled.text, 'utf8') <= 4096 + 8)
  assert.ok(readFileSync(hugeSettled.spillPath, 'utf8').includes('行0-'))
})

test('a fired deadline is classified as a timeout', async () => {
  // The e2e suite relies on this to tell a timeout from an abort; asserting it here
  // keeps that classification covered without spawning anything.
  const timer = deadline(undefined, 20, 'BASH_TIMEOUT')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.notEqual(timeoutOf(timer.signal, 'BASH_TIMEOUT'), undefined)
  timer[Symbol.dispose]?.()
})

test('an abort without an elapsed deadline is not a timeout', async () => {
  const controller = new AbortController()
  const timer = deadline(controller.signal, 60000, 'BASH_TIMEOUT')
  controller.abort()
  assert.equal(timeoutOf(timer.signal, 'BASH_TIMEOUT'), undefined)
  timer[Symbol.dispose]?.()
})
//#endregion
