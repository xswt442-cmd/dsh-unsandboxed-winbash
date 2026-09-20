// Pure unit tests for the Git Bash executor: PATH composition, environment
// scrubbing, Git-root derivation and the bounded output collector.
//
// Nothing here spawns a process, so it runs anywhere — including inside the dsh
// file sandbox, where SPAWNING is what a restricted token refuses. The spawning
// half is test/exec.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import pluginDefault, { apply, inject } from '../lib/tool/index.js'
import {
  buildEnvironment,
  candidateGitBashPaths,
  composePath,
  createCollector,
  gitRootOf,
  resolveGitBashPath,
  spawnBash
} from '../lib/tool/exec.js'

const B = String.fromCharCode(92)
const CANDIDATES = [
  'C:' + B + 'Program Files' + B + 'Git' + B + 'usr' + B + 'bin' + B + 'bash.exe',
  'C:' + B + 'Program Files' + B + 'Git' + B + 'bin' + B + 'bash.exe',
  'C:' + B + 'Program Files (x86)' + B + 'Git' + B + 'usr' + B + 'bin' + B + 'bash.exe'
]
// This plugin is a Windows plugin, so the suite runs where Git for Windows is
// installed — including CI, whose runner ships it. A missing install is a broken
// environment, not a case to skip.
const BASH = CANDIDATES.find((candidate) => existsSync(candidate))
assert.ok(BASH, 'Git for Windows is required to run this suite')

const BASE_CONFIG = {
  enableRunInBackground: true,
  bashPath: BASH,
  gitPathPrefix: true,
  extraPath: '',
  timeoutMs: 120000,
  maxTimeoutMs: 600000,
  maxOutputBytes: 64000,
  maxSpillBytes: 64 * 1024 * 1024,
  graceMs: 3000,
  drainMs: 250
}

const request = (command, extra = {}) => ({
  bashPath: BASH,
  command,
  dshEnv: { DSH_SHELL: '1' },
  ...extra
})

test('bash discovery never falls back to a PATH lookup', () => {
  // A bare `bash` on Windows resolves to the WSL shim (C:\Windows\System32\bash.exe),
  // which is a different shell; the resolver never returns one, and an explicit path
  // that does not exist is an error rather than a silent fallback.
  assert.throws(
    () => resolveGitBashPath('C:' + B + 'nope' + B + 'bash.exe', process.env),
    /does not exist/
  )
})

test('configured bashPath wins, and an unset one auto-discovers', () => {
  assert.equal(resolveGitBashPath(BASH, process.env), BASH, 'an existing configured path is returned as-is')
  assert.equal(resolveGitBashPath('', process.env), BASH, 'auto-discovery finds this machine Git Bash')
})

test('discovery falls back to real Windows paths when the environment omits ProgramFiles', () => {
  // Fallback literals are easy to over-escape: `"C:\Program Files"` evaluates to
  // `C:Program Files`, which is not a directory, so a host whose environment lacks
  // ProgramFiles would probe nowhere. Assert the composed path, not the source.
  const fallback = candidateGitBashPaths({})
  assert.equal(fallback[0], 'C:' + B + 'Program Files' + B + 'Git' + B + 'usr' + B + 'bin' + B + 'bash.exe')
  assert.equal(fallback[1], 'C:' + B + 'Program Files' + B + 'Git' + B + 'bin' + B + 'bash.exe')

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
  assert.equal(gitRootOf(CANDIDATES[0]), 'C:' + B + 'Program Files' + B + 'Git')
  assert.equal(gitRootOf(CANDIDATES[1]), 'C:' + B + 'Program Files' + B + 'Git')
  assert.equal(gitRootOf(CANDIDATES[2]), 'C:' + B + 'Program Files (x86)' + B + 'Git')
})

test('composePath places extra entries first and keeps the host PATH at the tail', () => {
  const composed = composePath({
    inherited: 'C:' + B + 'Windows;C:' + B + 'Windows' + B + 'System32;C:' + B + 'tools',
    bashPath: BASH,
    gitPathPrefix: true,
    extraPath: 'D:' + B + 'extra',
    exists: () => true
  })
  assert.ok(composed.startsWith('D:' + B + 'extra;'), composed)
  assert.ok(composed.indexOf('usr' + B + 'bin') < composed.indexOf('C:' + B + 'Windows;'), composed)
  assert.ok(composed.endsWith('C:' + B + 'Windows;C:' + B + 'Windows' + B + 'System32;C:' + B + 'tools'), composed)

  const deduped = composePath({
    inherited: 'C:' + B + 'tools;C:' + B + 'Tools;C:' + B + 'tools' + B,
    bashPath: BASH,
    gitPathPrefix: false,
    extraPath: '',
    exists: () => true
  })
  assert.equal(deduped, 'C:' + B + 'tools', 'de-duplication is case-insensitive')

  const untouched = composePath({
    inherited: 'C:' + B + 'Windows',
    bashPath: BASH,
    gitPathPrefix: false,
    extraPath: '',
    exists: () => true
  })
  assert.equal(untouched, 'C:' + B + 'Windows')
})

test('buildEnvironment repairs PATH and scrubs credential-shaped names', () => {
  const env = buildEnvironment(request('true'), BASE_CONFIG)
  assert.match(env.PATH, /usr\\bin/i)
  assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH').length, 1)
  assert.equal(env.NO_COLOR, '1')
  assert.equal(env.TERM, 'dumb')
  assert.equal(env.DSH_SHELL, '1', 'trusted DSH_* facts are forwarded')
  assert.ok(Object.keys(env).every((key) => !/KEY|PASSWORD|SECRET|TOKEN/i.test(key)))
})

test('the spawner keeps windowsHide on: that is the whole popup fix', () => {
  let captured
  const fakeChild = {
    pid: 4242,
    stdout: { on() {} },
    stderr: { on() {} },
    once(event, handler) {
      if (event === 'close') setImmediate(() => handler(0, null))
    },
    kill() {}
  }
  spawnBash(request('true'), BASE_CONFIG, undefined, {
    spawn: (file, args, options) => {
      captured = { file, args, options }
      return fakeChild
    },
    scrubbedParentEnv: () => ({ PATH: 'C:' + B + 'Windows' }),
    exists: () => true
  })
  assert.equal(captured.options.windowsHide, true)
  assert.equal(captured.args[0], '-c')
  assert.equal(captured.args[1], 'true')
  assert.deepEqual(captured.options.stdio, ['ignore', 'pipe', 'pipe'])
})

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

test('the plugin default carries inject, which is where the loader reads it', () => {
  // dsh reads a plugin's metadata off the value it applies, and with a default export
  // that value is the function, not the module namespace. `inject` left beside it as a
  // named export gives the loader an undeclared ctx.systemPrompt and fails the whole
  // boot -- "cannot get property systemPrompt without inject" -- which is the
  // regression 0.1.1 and 0.1.2 shipped. dsh-ballast and dsh-treekeeper attach it the
  // same way, and publish.yml runs this suite, so the guard gates a release.
  assert.equal(typeof pluginDefault, 'function', 'the default export is what the loader applies')
  assert.equal(pluginDefault, apply, 'the default export is the apply function')
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'shellEnv'])
  assert.deepEqual(pluginDefault.inject, inject, 'inject travels on the function')
})
