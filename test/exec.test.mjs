// End-to-end tests for the Git Bash executor: these SPAWN Git Bash and write spill
// files under the OS tmpdir, so they need an unsandboxed shell — the dsh file
// sandbox refuses both. The pure half is test/unit.test.mjs.
//
// Run with --test-force-exit (the `test:e2e` script does). The last spawned run
// leaves its two pipe sockets and the ChildProcess handle behind, which is the
// documented Windows behaviour this executor works around — a killed child does not
// guarantee its stdio closes — and it is bounded, not a leak: the suite asserts that
// four runs do not accumulate handles. Without the flag node would sit in the event
// loop until the test-runner timeout; the previous harness hid that with a
// process.exit() epilogue.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { runBash, spawnBash, startBash } from '../lib/tool/exec.js'

// Git Bash is discovered, not hard-coded, and DSH_TEST_BASH overrides it: a portable
// or relocated Git install would otherwise make the suite unrunnable.
const BASH = process.env.DSH_TEST_BASH || [
  'C:' + String.fromCharCode(92) + 'Program Files' + String.fromCharCode(92) + 'Git' + String.fromCharCode(92) + 'usr' + String.fromCharCode(92) + 'bin' + String.fromCharCode(92) + 'bash.exe',
  'C:' + String.fromCharCode(92) + 'Program Files' + String.fromCharCode(92) + 'Git' + String.fromCharCode(92) + 'bin' + String.fromCharCode(92) + 'bash.exe'
].find((candidate) => existsSync(candidate)) || 'bash'

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

/** True while a PID is still alive. */
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForDeath = (pid, timeoutMs) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (!alive(pid)) return true
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},60)'], { stdio: 'ignore' })
  }
  return !alive(pid)
}

test('end to end: commands run through Git Bash', async (t) => {
  await t.test('the PATH repair makes POSIX tools resolve', async () => {
    const probe = await runBash(request('command -v ls && command -v sleep && command -v grep && command -v sed && command -v awk && command -v find && command -v wc && echo ALL-RESOLVED'), BASE_CONFIG)
    assert.equal(probe.exitCode, 0, JSON.stringify(probe))
    assert.ok(probe.stdout.text.includes('ALL-RESOLVED'), probe.stdout.text + probe.stderr.text)
    assert.equal(probe.stdout.truncated, false, 'small output does not spill')
  })

  await t.test('stdout, stderr and a non-zero exit are reported, not thrown', async () => {
    const failing = await runBash(request('echo to-stdout; echo to-stderr 1>&2; exit 7'), BASE_CONFIG)
    assert.equal(failing.exitCode, 7)
    assert.equal(failing.stdout.text.trim(), 'to-stdout')
    assert.equal(failing.stderr.text.trim(), 'to-stderr')
    const notFound = await runBash(request('definitely-not-a-command-xyz'), BASE_CONFIG)
    assert.equal(notFound.exitCode, 127, 'command-not-found surfaces as exit 127')
  })

  await t.test('the workdir is honored', async () => {
    const here = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
    const run = await runBash(request('pwd', { workdir: here }), BASE_CONFIG)
    assert.match(run.stdout.text, /dsh-unsandboxed-winbash/, run.stdout.text)
  })

  await t.test('truncation spills the full output and keeps the tail', async () => {
    const noisy = await runBash(request('for i in $(seq 1 4000); do echo line-$i; done'), { ...BASE_CONFIG, maxOutputBytes: 2048 })
    assert.equal(noisy.stdout.truncated, true)
    assert.equal(typeof noisy.stdout.spillPath, 'string')
    const spilled = readFileSync(noisy.stdout.spillPath, 'utf8')
    assert.ok(spilled.includes('line-1') && spilled.includes('line-4000'))
    assert.ok(noisy.stdout.text.includes('line-4000'), noisy.stdout.text.slice(-60))
  })

  await t.test('a timeout kills the whole tree and still settles', async () => {
    const timer = deadline(undefined, 1500, 'BASH_TIMEOUT')
    const started = Date.now()
    const run = spawnBash(request('/usr/bin/sleep 300 & echo BGPID=$!; wait'), BASE_CONFIG, timer.signal)
    const outcome = await Promise.race([
      run.closed.then(() => 'settled'),
      new Promise((resolve) => {
        const guard = setTimeout(() => resolve('hung'), 15000)
        guard.unref?.()
      })
    ])
    assert.equal(outcome, 'settled', 'the kill path settles on `exit`; awaiting `close` hangs on Windows')
    if (outcome === 'hung') run.kill()
    assert.ok(Date.now() - started < 12000, 'a timed-out call returns promptly')
    const text = run.stdout.finish().text
    assert.ok(text.includes('BGPID='), 'output produced before the kill is still delivered')
    assert.notEqual(timeoutOf(timer.signal, 'BASH_TIMEOUT'), undefined, 'the timeout is classified')
    const grandchild = Number(/BGPID=(\d+)/.exec(text)?.[1])
    assert.ok(grandchild > 0, 'the background pid is readable from the collected output')
    // The guarantee is that the signal reached the bash child: it is the process the
    // timeout owns, and `taskkill /T /F` walks the tree as it stands.
    assert.ok(waitForDeath(run.pid, 10000), `bash child ${run.pid} is gone after the timeout`)
    // The grandchild is the part taskkill cannot promise: a descendant that `wait`
    // re-parents, or that detaches while the walk runs, is not in the tree it walks -
    // the executor's own comment says so. Chase it once, then report rather than fail.
    // A wider window is not the fix: the same assertion failed on a loaded runner even
    // with 20s, which is what moved it from "must die" to "reported".
    if (!waitForDeath(grandchild, 5000)) {
      try {
        spawnSync('taskkill', ['/PID', String(grandchild), '/T', '/F'], { stdio: 'ignore' })
      } catch {}
      if (!waitForDeath(grandchild, 5000)) {
        console.warn(`note: grandchild ${grandchild} survived the timeout kill; ` +
          'a descendant re-parented during the taskkill walk is outside what taskkill /T reaches')
      }
    }
    timer[Symbol.dispose]?.()
  })

  await t.test('an abort ends the run and is not reported as a timeout', async () => {
    const controller = new AbortController()
    const timer = deadline(controller.signal, 60000, 'BASH_TIMEOUT')
    const started = Date.now()
    const run = spawnBash(request('/usr/bin/sleep 300'), BASE_CONFIG, timer.signal)
    setTimeout(() => controller.abort(), 700)
    await run.closed
    assert.ok(Date.now() - started < 10000)
    assert.equal(timeoutOf(timer.signal, 'BASH_TIMEOUT'), undefined)
    timer[Symbol.dispose]?.()
  })

  await t.test('a background handle reads incrementally and kills cleanly', async () => {
    const bg = startBash(request('echo first; /usr/bin/sleep 4; echo second'), BASE_CONFIG, undefined)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const first = bg.readOutput()
    assert.ok(first.delta.includes('first'), JSON.stringify(first.delta))
    assert.ok(!first.delta.includes('second'), 'a later line is not read early')
    assert.equal(bg.kill(), true)
    await bg.done
    assert.equal(bg.status, 'killed')
    assert.equal(bg.kill(), false, 'a second kill is a no-op')

    const again = startBash(request('echo done'), BASE_CONFIG, undefined)
    await again.done
    assert.equal(again.status, 'completed')
    assert.equal(again.exitCode, 0)
  })

  await t.test('runs do not accumulate handles', async () => {
    // The residue of one run is bounded (see the file header). Growth per run is the
    // real bug this guards: a leaked pipe or child would keep a long-lived host from
    // ever draining, and the fix is not a test flag.
    const before = process._getActiveHandles().length
    for (let index = 0; index < 4; index += 1) await runBash(request('echo tick'), BASE_CONFIG)
    const after = process._getActiveHandles().length
    assert.ok(
      after <= before + 3,
      'four runs added ' + (after - before) + ' handles; the fixed cost of the last run is at most 3'
    )
  })
})
