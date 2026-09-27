// End-to-end tests for the Git Bash executor: these SPAWN Git Bash and write spill
// files under the OS tmpdir, so they need an unsandboxed shell and a real Git for
// Windows — the dsh file sandbox refuses both. The pure half is test/unit/, and
// test/unit/layout.test.mjs is what keeps that split honest.
//
// Run with --test-force-exit (the `test:e2e` script does). The last spawned run
// leaves its two pipe sockets and the ChildProcess handle behind, which is the
// documented Windows behaviour this executor works around — a killed child does not
// guarantee its stdio closes — and it is bounded, not a leak: the last test in this
// file asserts that repeated runs do not accumulate handles. Without the flag node
// would sit in the event loop until the test-runner timeout.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { resolveGitBashPath, runBash, spawnBash, startBash } from '../../lib/tool/exec.js'

// Git Bash is discovered by the plugin's own resolver, and DSH_TEST_BASH overrides
// it for a portable or relocated install. This is the only layer that depends on the
// machine, so the resolver's failure is re-raised with what a contributor has to do.
let BASH
try {
  BASH = process.env.DSH_TEST_BASH || resolveGitBashPath('')
} catch (error) {
  throw new Error('test/e2e spawns real Git Bash: install Git for Windows or point DSH_TEST_BASH at bash.exe', { cause: error })
}

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
  // Streams are real here, so the drain window is the production one.
  drainMs: 250
}

const request = (command, extra = {}) => ({
  bashPath: BASH,
  command,
  dshEnv: { DSH_SHELL: '1' },
  ...extra
})

// Timeouts below are ceilings on a wait that is driven by an event (a process
// disappearing, a line arriving), never a guess about how long the machine needs:
// a forced `taskkill /F` and a bash `echo` are immediate, so a budget only has to
// cover a loaded CI runner. Each is stated with that reasoning where it is used.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolve with `value` once `ms` pass; used only as a "still stuck?" guard. */
const after = (ms, value) => new Promise((resolve) => {
  const guard = setTimeout(() => resolve(value), ms)
  guard.unref?.()
})

/** True while a Windows pid is still alive. */
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Wait for a pid to disappear; never blocks the loop while doing it. */
async function waitForDeath(pid, budgetMs = 15000) {
  const until = Date.now() + budgetMs
  while (alive(pid)) {
    if (Date.now() >= until) return !alive(pid)
    await sleep(50)
  }
  return true
}

const POWERSHELL = join(process.env.SystemRoot ?? 'C:' + String.fromCharCode(92) + 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/**
 * Windows pids whose recorded parent is `pid`.
 *
 * A shell job number (`$!`) is an MSYS pid, not necessarily a Windows one, so the
 * tree-kill assertion cannot chase it. Windows records the creating parent on every
 * process and keeps it after that parent dies, so the kernel's own view answers the
 * only question that matters: is anything from that tree still running?
 */
function windowsChildrenOf(pid) {
  const probe = spawnSync(POWERSHELL, [
    '-NoProfile',
    '-NonInteractive',
    '-Command', `Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = ${pid}" | ForEach-Object { $_.ProcessId }`
  ], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: [
      'ignore',
      'pipe',
      'pipe'
    ]
  })
  if (probe.error ?? probe.status !== 0) throw new Error(`cannot enumerate the descendants of ${pid}: ${probe.stderr ?? probe.error}`)
  return probe.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).map(Number)
}

/** Poll the kernel's parent table until the tree is empty; returns what survived. */
async function survivingDescendantsOf(pid, budgetMs = 15000) {
  const until = Date.now() + budgetMs
  for (;;) {
    const children = windowsChildrenOf(pid)
    if (children.length === 0 || Date.now() >= until) return children
    await sleep(250)
  }
}

/** Reap whatever a failed assertion left behind, so the machine is not littered. */
const forceReap = (pid) => spawnSync('taskkill', [
  '/PID',
  String(pid),
  '/T',
  '/F'
], { stdio: 'ignore', windowsHide: true })

/**
 * The number of live handles, read the same way the executor's own residue shows
 * up. `_getActiveHandles` is private but present on every node this plugin supports.
 */
function activeHandles() {
  assert.equal(typeof process._getActiveHandles, 'function', 'the suite needs process._getActiveHandles()')
  return process._getActiveHandles().length
}

const EXEC_MODULE = new URL('../../lib/tool/exec.js', import.meta.url).href

/**
 * The supervisor process that stands in for the host: one real winbash child, then an
 * exit, with the teardown hooks installed only when `WB_HOOK` says so.
 *
 * This is the half the unit layer cannot do: there the reaper is a recorder, so a
 * green test proves only which arguments the code chose. Here the reaper is the real
 * `taskkill`, and what a pass shows is that a real bash tree really disappears.
 */
const fixtureSource = `
import { installChildTeardown, spawnBash } from ${JSON.stringify(EXEC_MODULE)};
const bash = process.env.WB_BASH;
const config = {
  bashPath: bash,
  gitPathPrefix: false,
  extraPath: '',
  maxOutputBytes: 1024,
  maxSpillBytes: 1 << 20,
  graceMs: 3000,
  drainMs: 250
};
// Two sleeps, so a tree kill has to walk past the direct child to be clean. Sixty
// seconds rather than the five minutes the other kill tests use: long enough that the
// 15-second survivor poll below cannot be satisfied by a job that escaped the tree walk
// exiting on its own, short enough that such a job clears itself off the machine.
const handle = spawnBash({ bashPath: bash, command: '/usr/bin/sleep 60 & /usr/bin/sleep 60', dshEnv: {} }, config, undefined);
process.stdout.write(JSON.stringify({ bash: handle.pid }) + '\\n');
if (process.env.WB_HOOK === '1') installChildTeardown();
setTimeout(() => process.exit(0), 400);
`

/**
 * Run the host fixture to completion and report the bash pid it was running.
 *
 * `withTeardown: false` reproduces the control behind the note in the test that uses
 * this: the same exit with no hook installed, which the suite does not assert on
 * because what it shows depends on the machine's own process containment.
 */
function runHostFixture(withTeardown = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', fixtureSource], {
      env: {
        ...process.env,
        WB_BASH: BASH,
        WB_HOOK: withTeardown ? '1' : '0'
      },
      stdio: [
        'ignore',
        'pipe',
        'pipe'
      ],
      windowsHide: true
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`the host fixture exited ${code}: ${err}`))
      else resolve({ bash: Number(JSON.parse(out).bash) })
    })
  })
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
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]+$/, '')
    // `pwd -W` is MSYS2's Windows-shaped form, so the comparison is path-for-path
    // instead of "does it look like the repository".
    const run = await runBash(request('pwd -W', { workdir: repoRoot }), BASE_CONFIG)
    assert.equal(run.stdout.text.trim().replace(/[\\/]+/g, '/'), repoRoot.replace(/[\\/]+/g, '/'), run.stdout.text)
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
    t.after(() => timer[Symbol.dispose]?.())
    const started = Date.now()
    const run = spawnBash(request('/usr/bin/sleep 300 & echo BGPID=$!; wait'), BASE_CONFIG, timer.signal)
    const outcome = await Promise.race([
      run.closed.then(() => 'settled'),
      after(20000, 'hung')
    ])
    assert.equal(outcome, 'settled', 'the kill path settles on `exit`; awaiting `close` hangs on Windows')
    // Ceiling only: a broken kill would hang forever, which is what this guards, and
    // the settle assertion above is the real one. A loaded runner can spend seconds
    // between the deadline firing and the reaper returning.
    assert.ok(Date.now() - started < 30000, 'a timed-out call returns promptly')
    const text = run.stdout.finish().text
    assert.ok(text.includes('BGPID='), 'output produced before the kill is still delivered')
    assert.notEqual(timeoutOf(timer.signal, 'BASH_TIMEOUT'), undefined, 'the timeout is classified')
    assert.ok(await waitForDeath(run.pid), `bash child ${run.pid} is gone after the timeout`)
    // The integrity of the tree kill is the point of this plugin's kill path, so it
    // is asserted, not reported: nothing the killed bash created may still exist.
    const survivors = await survivingDescendantsOf(run.pid)
    for (const pid of survivors) forceReap(pid)
    assert.deepEqual(survivors, [], `descendants of ${run.pid} survived the tree kill`)
  })

  await t.test('an abort ends the run and is not reported as a timeout', async () => {
    const controller = new AbortController()
    const timer = deadline(controller.signal, 60000, 'BASH_TIMEOUT')
    t.after(() => timer[Symbol.dispose]?.())
    const started = Date.now()
    const run = spawnBash(request('/usr/bin/sleep 300'), BASE_CONFIG, timer.signal)
    await new Promise((resolve) => {
      const delay = setTimeout(resolve, 700)
      delay.unref?.()
    })
    controller.abort()
    const outcome = await Promise.race([
      run.closed.then(() => 'settled'),
      after(20000, 'hung')
    ])
    assert.equal(outcome, 'settled')
    // Same ceiling reasoning as the timeout case: the abort is the event, the clock
    // only says a broken path would otherwise hang the suite.
    assert.ok(Date.now() - started < 30000, 'an aborted call returns promptly')
    assert.equal(timeoutOf(timer.signal, 'BASH_TIMEOUT'), undefined)
    assert.ok(await waitForDeath(run.pid), `bash child ${run.pid} is gone after the abort`)
  })

  await t.test('a host that exits really takes its bash tree with it', async () => {
    // The reaper here is the real `taskkill` and the tree is a real bash with two
    // sleeps, so this is the measurement the unit layer's recorder cannot make: the
    // exit hook reaches the whole tree and the host still exits cleanly behind it.
    //
    // What this does NOT prove is that the hook is the only thing standing between a
    // host exit and an orphan. The same fixture run with `installChildTeardown` left
    // out was measured on a Windows host and the tree died anyway, because libuv
    // assigns every non-detached child to its own kill-on-close Job Object. What that
    // run also showed is the case the hook is for: a descendant outside the reach of
    // that containment survives a host death, and only a whole-tree kill clears it.
    const reaped = await runHostFixture(true)
    t.after(() => forceReap(reaped.bash))
    assert.ok(await waitForDeath(reaped.bash), `bash child ${reaped.bash} outlived a host that had the teardown hook`)
    const survivors = await survivingDescendantsOf(reaped.bash)
    for (const pid of survivors) forceReap(pid)
    assert.deepEqual(survivors, [], `descendants of ${reaped.bash} survived the host exit`)
  })

  await t.test('a background handle reads incrementally and kills cleanly', async () => {
    const bg = startBash(request('echo first; /usr/bin/sleep 30; echo second'), BASE_CONFIG, undefined)
    // Wait for the line to arrive instead of sleeping into the middle of the run. The
    // paired command sleeps 30s before its second line, so "not yet read" is a wide
    // margin rather than a race against a 4-second timer.
    let delta = ''
    const until = Date.now() + 20000
    while (!delta.includes('first') && Date.now() < until) {
      delta += bg.readOutput().delta
      if (!delta.includes('first')) await sleep(50)
    }
    assert.ok(delta.includes('first'), `the first line arrived (got: ${JSON.stringify(delta)})`)
    assert.ok(!delta.includes('second'), 'a later line is not read early')
    assert.equal(bg.kill(), true)
    await bg.done
    assert.equal(bg.status, 'killed')
    assert.equal(bg.kill(), false, 'a second kill is a no-op')

    const again = startBash(request('echo done'), BASE_CONFIG, undefined)
    await again.done
    assert.equal(again.status, 'completed')
    assert.equal(again.exitCode, 0)
    assert.ok(again.readOutput().delta.includes('done'))
  })

  await t.test('runs do not accumulate handles', async () => {
    // The residue of one run is bounded (see the file header). Growth per run is the
    // real bug this guards: a leaked pipe or child would keep a long-lived host from
    // ever draining, and the fix is not a test flag.
    const before = activeHandles()
    for (let index = 0; index < 4; index += 1) await runBash(request('echo tick'), BASE_CONFIG)
    // The last run releases its sockets asynchronously after `exit`, so the count is
    // read once it stops moving instead of at an arbitrary instant after the await.
    let after = activeHandles()
    for (let stable = 0; stable < 6 && after > before + 3; stable += 1) {
      await sleep(100)
      after = activeHandles()
    }
    assert.ok(
      after <= before + 3,
      'four runs added ' + (after - before) + ' handles; the fixed cost of the last run is at most 3'
    )
  })
})
