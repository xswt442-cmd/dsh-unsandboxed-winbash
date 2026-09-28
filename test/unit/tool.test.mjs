// Pure unit tests for the winbash tool module: the argument guard, the background
// policy and everything the registered tool promises the model.
//
// This is the plugin's only policy surface, so it is asserted here with no process
// ever spawned: the executor seams are the real ones, but every case below either
// throws before reaching them or hands work to a fake job registry that is never
// asked to run it. See test/unit/layout.test.mjs for that rule.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import pluginDefault, { apply, inject, validateWinbashArgs } from '../../lib/tool/index.js'
import { teardownSignals } from '../../lib/tool/exec.js'

// A file that exists but is not a shell: `resolveGitBashPath` accepts it, so the
// tool mounts without probing the machine for Git for Windows, and any code path
// that actually tried to spawn it would fail loudly instead of quietly passing.
const NOT_A_SHELL = fileURLToPath(import.meta.url)

/**
 * Mount the plugin against a fake dsh context and return the tool it registered.
 *
 * `effects` collects the disposer each `ctx.effect` returns, exactly as the host
 * would, and every caller disposes them in a teardown so a test cannot leave
 * process-level hooks behind.
 */
function mount(config = {}, { jobs } = {}) {
  const tools = []
  const sections = []
  const effects = []
  const ctx = {
    effect(fn, label) {
      effects.push({
        label,
        dispose: fn()
      })
    },
    systemPrompt: { section: (section) => sections.push(section) },
    tools: { register: (tool) => tools.push(tool) },
    shellEnv: { collect: () => ({ DSH_SHELL: '1' }) },
    get: (key) => key === 'jobs' ? jobs : void 0
  }
  apply(ctx, {
    bashPath: NOT_A_SHELL,
    ...config
  })
  return {
    tool: tools[0],
    sections,
    effects,
    tools,
    ctx
  }
}

const AGENT = {
  session: { header: { cwd: 'C:' + String.fromCharCode(92) + 'work' } }
}
const execWith = (signal = new AbortController().signal, agent) => ({
  signal,
  agent
})

const FOREGROUND_PARAMETERS = ['command', 'description', 'timeoutMs', 'workdir']

//#region registered shape
test('the tool keeps the identity and the surface it is known by', async (t) => {
  const mounted = mount()
  t.after(() => mounted.effects.forEach((effect) => effect.dispose()))
  // Renaming the tool would invalidate every prompt and transcript that already
  // refers to it, so the name is part of the contract, not a label.
  assert.equal(mounted.tool.name, 'winbash')
  assert.deepEqual(Object.keys(mounted.tool.parameters.properties), FOREGROUND_PARAMETERS.concat('run_in_background'))
  assert.equal(mounted.tools.length, 1, 'the plugin adds one tool and replaces nothing')
})

test('the tool states the sandbox boundary and offers no way out of it', async (t) => {
  const mounted = mount()
  t.after(() => mounted.effects.forEach((effect) => effect.dispose()))
  const description = mounted.tool.description
  assert.match(description, /OUTSIDE the file-effect sandbox/, 'the description says where the command runs')
  assert.match(description, /no `sandbox_permissions`/, 'and says there is nothing to escalate')
  // The escalation surface this plugin must never grow: there is no sandbox to
  // escape from, so a permission knob here would be a lie to the host.
  assert.equal('sandbox_permissions' in mounted.tool, false)
  assert.equal('sandboxPermissions' in mounted.tool, false)
  assert.equal(Object.keys(mounted.tool).filter((key) => /permission|sandbox/i.test(key)).length, 0)
})

test('the host-facing prompt section warns about the exit-code contract', async (t) => {
  const mounted = mount()
  t.after(() => mounted.effects.forEach((effect) => effect.dispose()))
  assert.equal(mounted.sections.length, 1)
  assert.equal(mounted.sections[0].name, 'tool:winbash')
  assert.match(mounted.sections[0].text, /OUTSIDE the file-effect sandbox/)
})

test('child teardown is wired once, at mount, and unwired on dispose', () => {
  // What is pinned here is the wiring: one watcher per name the platform rule
  // selects, nothing for a name it does not select, and every one of them gone after
  // dispose. Which names the rule itself selects is pinned in unit/exec.test.mjs, so
  // this one reads the rule rather than restating it.
  const names = ['exit', ...teardownSignals(process.platform), 'SIGTERM'].filter((name, index, all) => all.indexOf(name) === index)
  const hooked = () => names.map((name) => process.listenerCount(name))
  const baseline = hooked()
  const watched = names.map((name) => (name === 'exit' || teardownSignals(process.platform).includes(name) ? 1 : 0))
  const mounted = mount()
  assert.equal(mounted.effects.length, 1, 'the plugin installs exactly one process-level hook set')
  assert.equal(mounted.effects[0].label, 'winbash child teardown')
  assert.equal(typeof mounted.effects[0].dispose, 'function')
  assert.deepEqual(hooked(), baseline.map((count, index) => count + watched[index]), 'mount adds one listener per watched name and none elsewhere')
  mounted.effects[0].dispose()
  assert.deepEqual(hooked(), baseline, 'dispose leaves no hook behind')
})

test('the plugin default carries inject, which is where the loader reads it', () => {
  // dsh reads a plugin's metadata off the value it applies, and with a default export
  // that value is the function, not the module namespace. `inject` left beside it as a
  // named export gives the loader an undeclared ctx.systemPrompt and fails the whole
  // boot -- "cannot get property systemPrompt without inject" -- which is the
  // regression 0.1.1 and 0.1.2 shipped. `publish.yml` runs this suite, so the guard
  // gates a release.
  assert.equal(typeof pluginDefault, 'function', 'the default export is what the loader applies')
  assert.equal(pluginDefault, apply, 'the default export is the apply function')
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'shellEnv'])
  assert.deepEqual(pluginDefault.inject, inject, 'inject travels on the function')
})
//#endregion
//#region argument guard
test('the argument guard checks the type before it touches the value', () => {
  // The bug this pins: `args.command.trim()` on a number, an object or a missing
  // property threw a TypeError out of the guard instead of returning a validation
  // error, so the model got a stack trace where it should get a rule.
  for (const bad of [
    {},
    void 0,
    null,
    { command: 42, description: 'x' },
    { command: ['ls'], description: 'x' },
    { command: { toString: 'ls' }, description: 'x' },
    { command: '   ', description: 'x' },
    { command: '\n\t ', description: 'x' }
  ]) assert.throws(() => validateWinbashArgs(bad), {
    name: 'Error',
    message: /invalid command: expected a non-empty string/
  }, `command ${JSON.stringify(bad) ?? String(bad)}`)

  for (const bad of [
    { command: 'ls' },
    { command: 'ls', description: 7 },
    { command: 'ls', description: '' }
  ]) assert.throws(() => validateWinbashArgs(bad), /invalid description: expected a non-empty string/)

  for (const bad of [
    { command: 'ls', description: 'x', timeoutMs: 0 },
    { command: 'ls', description: 'x', timeoutMs: -1 },
    { command: 'ls', description: 'x', timeoutMs: Number.NaN },
    { command: 'ls', description: 'x', timeoutMs: Number.POSITIVE_INFINITY }
  ]) assert.throws(() => validateWinbashArgs(bad), /invalid timeoutMs: expected a positive number/)
})

test('a valid argument set passes the guard, and an absent timeout is fine', () => {
  assert.doesNotThrow(() => validateWinbashArgs({ command: 'ls', description: 'List files' }))
  assert.doesNotThrow(() => validateWinbashArgs({ command: 'ls', description: 'List files', timeoutMs: 1000 }))
})

test('a rejected call comes back as a validation error, never as a spawn', async (t) => {
  const mounted = mount()
  t.after(() => mounted.effects.forEach((effect) => effect.dispose()))
  // The configured bash path is a file that cannot be executed, so reaching the
  // executor at all would change the error: what is asserted is that it does not.
  await assert.rejects(() => mounted.tool.execute({ command: '   ', description: 'x' }, execWith()), /invalid command: expected a non-empty string/)
  await assert.rejects(() => mounted.tool.execute({ command: 'ls', description: '   ' }, execWith()), /invalid description/)
  await assert.rejects(() => mounted.tool.execute({ command: 'ls', description: 'x', timeoutMs: 0 }, execWith()), /invalid timeoutMs/)
  // The host's own schema check runs first and is equally non-spawning.
  await assert.rejects(() => mounted.tool.execute({ command: 'ls' }, execWith()), /missing required property "description"/)
  await assert.rejects(() => mounted.tool.execute({ command: 42, description: 'x' }, execWith()), /must be a string/)
})

test('an aborted call is reported as an abort', async (t) => {
  const mounted = mount({}, { jobs: { start: () => 'job-1' } })
  t.after(() => mounted.effects.forEach((effect) => effect.dispose()))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => mounted.tool.execute({
    command: 'ls',
    description: 'List files',
    run_in_background: true
  }, execWith(controller.signal)), (error) => {
    assert.equal(error.name, 'AbortError')
    return true
  })
})
//#endregion
//#region background policy
test('a deployment with background execution closed rejects the parameter', async (t) => {
  const mounted = mount({ enableRunInBackground: false }, { jobs: { start: () => 'never' } })
  t.after(() => mounted.effects.forEach((effect) => effect.dispose()))
  // The parameter is not offered to the model at all...
  assert.equal('run_in_background' in mounted.tool.parameters.properties, false)
  assert.match(mounted.tool.description, /Background execution is not available/)
  // ...and the tool still refuses it when a model sends it anyway: the host schema
  // does not forbid extra properties, so this guard is the enforcement point.
  await assert.rejects(() => mounted.tool.execute({
    command: 'sleep 1',
    description: 'Wait',
    run_in_background: true
  }, execWith()), /run_in_background is disabled for this deployment/)
})

test('background execution without the host job registry is refused, not silently run', async (t) => {
  const mounted = mount()
  t.after(() => mounted.effects.forEach((effect) => effect.dispose()))
  await assert.rejects(() => mounted.tool.execute({
    command: 'sleep 1',
    description: 'Wait',
    run_in_background: true
  }, execWith()), /background jobs unavailable/)
})

test('a background call registers a job and does not start a process by itself', async (t) => {
  const registered = []
  const mounted = mount({}, {
    jobs: { start: (descriptor) => {
      registered.push(descriptor)
      return `job-${registered.length}`
    } }
  })
  t.after(() => mounted.effects.forEach((effect) => effect.dispose()))
  const result = await mounted.tool.execute({
    command: 'sleep 300',
    description: 'Wait',
    run_in_background: true
  }, execWith())
  assert.deepEqual(result, {
    kind: 'background',
    jobId: 'job-1'
  })
  assert.equal(registered[0].kind, 'winbash')
  assert.equal(registered[0].label, 'sleep 300', 'the job is labelled with the command it runs')
  // `run` is a thunk the registry owns: the tool never calls it here, which is what
  // makes "no process was started by this call" observable.
  assert.deepEqual(Object.keys(registered[0]).sort(), ['kind', 'label', 'run'], 'no agent means no owner to attribute')
  await mounted.tool.execute({
    command: 'sleep 60',
    description: 'Wait longer',
    run_in_background: true
  }, execWith(undefined, AGENT))
  assert.deepEqual(registered[1].owner, AGENT, 'a call from an agent attributes the job to it')
})

test('output rendering reports a non-zero exit as a marker, not as an error', async (t) => {
  const mounted = mount()
  t.after(() => mounted.effects.forEach((effect) => effect.dispose()))
  const rendered = mounted.tool.output.render({
    command: 'false',
    description: 'Run false'
  }, {
    kind: 'foreground',
    exitCode: 7,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 120000,
    stdout: {
      text: 'out',
      truncated: false
    },
    stderr: {
      text: 'bad',
      truncated: false
    }
  })
  assert.equal(rendered[0].text, 'out\n[stderr]\nbad\n[exit code: 7]')
  const background = mounted.tool.output.render({}, {
    kind: 'background',
    jobId: 'job-7'
  })
  assert.equal(background[0].text, 'started background job job-7')
})
//#endregion
