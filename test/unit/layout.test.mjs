// The suite layout itself is a contract, and until now nothing enforced it:
// `npm test` named one fixed file, so a test added anywhere else was simply never
// run, and `AGENTS.md`'s promise that the unit layer spawns no process was
// guarded by nothing.
//
// This file is the unit layer's own meta-test, so it touches the file system and
// nothing else.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_ROOT = fileURLToPath(new URL('../', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url))
const LAYERS = ['unit', 'e2e']
// This file states the forbidden strings in its own patterns, so it cannot be
// scanned with them; the rule it enforces on the rest of the layer is the point.
const SELF = 'unit/layout.test.mjs'
const TEST_FILE = /\.test\.(?:m|c)?js$/

/** Every file below test/, as test/-relative POSIX paths. */
function walk(directory) {
  return readdirSync(join(TEST_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const nested = directory.length === 0 ? entry.name : `${directory}/${entry.name}`
    return entry.isDirectory() ? walk(nested) : [nested]
  })
}
const files = walk('')
const layerOf = (file) => LAYERS.find((layer) => file.startsWith(`${layer}/`))

const testFilesIn = (layer) => files.filter((file) => layerOf(file) === layer && TEST_FILE.test(file)).map((file) => file.slice(layer.length + 1))
const sourceOf = (file) => readFileSync(join(TEST_ROOT, file.split('/').join(sep)), 'utf8')

const scripts = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).scripts

test('every test file belongs to a layer, and no layer root holds a stray', () => {
  // A file left sitting in test/ — or in a directory no command collects — is
  // invisible to both scripts, which is exactly the failure this guard makes loud.
  const orphans = files.filter((file) => TEST_FILE.test(file) && layerOf(file) === undefined)
  assert.deepEqual(orphans, [], `test files must live under test/${LAYERS.join('/')} or test/…: ${orphans.join(', ')}`)
  assert.ok(existsSync(join(TEST_ROOT, 'unit')), 'test/unit/ must exist')
  assert.ok(existsSync(join(TEST_ROOT, 'e2e')), 'test/e2e/ must exist')
})

test('both layers hold test files, and no collected file is named in a script', () => {
  assert.ok(testFilesIn('unit').length >= 3, 'the unit layer has content')
  assert.ok(testFilesIn('e2e').length >= 1, 'the e2e layer has content')
  // A file in a collected layer that the runner would not pick up by name is
  // silently never run, which is the same hole as a stray directory.
  for (const layer of LAYERS) {
    const skipped = files.filter((file) => layerOf(file) === layer && /\.(?:m|c)?js$/.test(file) && !TEST_FILE.test(file))
    assert.deepEqual(skipped, [], `test/${layer} holds .js files no test script collects: ${skipped.join(', ')}`)
  }
})

test('the test commands collect a whole layer, without a shell-dependent pattern', () => {
  // `node --test <file>` was the old shape: it silently skipped every file that
  // was not named on the command line. Naming the layer is right, but how matters:
  // a glob in an npm script only works if the shell expands it (Git Bash does,
  // cmd and PowerShell do not), a glob given to node needs test-runner glob
  // support that postdates the `engines.node` floor, and a directory is treated
  // as a file to execute. So a runner script enumerates the layer and the command
  // line carries only fixed paths.
  assert.match(scripts.test, /run-layer\.mjs\s+test\/unit(\s|$)/, `npm test must collect the unit layer, got: ${scripts.test}`)
  assert.match(scripts['test:e2e'], /run-layer\.mjs\s+test\/e2e\b/, `test:e2e must collect the e2e layer, got: ${scripts['test:e2e']}`)
  for (const [name, script] of Object.entries(scripts)) {
    assert.doesNotMatch(script, /[\w./*-]+\*\*/, `${name} must not carry a glob the shell may or may not expand`)
  }
  assert.doesNotMatch(scripts.test, /unit\/[\w.-]+\.test/, 'npm test must not name a single unit file')
  assert.doesNotMatch(scripts['test:e2e'], /e2e\/[\w.-]+\.test/, 'test:e2e must not name a single e2e file')
  // The collector the scripts delegate to must exist: pointing at a missing
  // runner is the same silent-skip failure in a different costume.
  for (const [, script] of Object.entries(scripts)) {
    for (const file of script.match(/[\w./-]+\.mjs/g) || []) {
      assert.ok(existsSync(join(ROOT, file)), `${file} referenced by an npm script does not exist`)
    }
  }
})

test('the unit layer never spawns, which is what AGENTS.md promises', () => {
  // `npm test` is documented as pure units that also run inside a sandboxed shell,
  // where SPAWNING is what the restricted token refuses. The e2e layer is allowed to
  // spawn; the unit layer is not, and reading the sources is enough to hold it to
  // that: no child_process import, and no real-spawn entry point called at all.
  for (const file of files.filter((entry) => layerOf(entry) === 'unit' && entry !== SELF)) {
    const source = sourceOf(file)
    assert.doesNotMatch(source, /from\s+['"]node:child_process['"]/, `${file} imports node:child_process`)
    assert.doesNotMatch(source, /require\(['"]node:child_process['"]\)/, `${file} requires node:child_process`)
    assert.doesNotMatch(source, /\brunBash\s*\(/, `${file} calls runBash, which spawns for real`)
    assert.doesNotMatch(source, /\bstartBash\s*\(/, `${file} calls startBash, which spawns for real`)
    assert.doesNotMatch(source, /\bDSH_TEST_BASH\b/, `${file} reads the e2e layer's executable override`)
  }
})

test('the e2e layer is the only one that depends on a local Git Bash', () => {
  for (const file of files.filter((entry) => layerOf(entry) === 'e2e')) {
    assert.match(sourceOf(file), /\bDSH_TEST_BASH\b/, `${file} should honour the DSH_TEST_BASH override`)
  }
})
