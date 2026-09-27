#!/usr/bin/env node
// Run every test file of one layer: `node scripts/run-layer.mjs test/unit`.
//
// The layer is enumerated here rather than by the shell or the test runner,
// because both of those answers are conditional. A glob in an npm script only
// works if something expands it, and that depends on which shell npm hands the
// script to — Git Bash does, `cmd` and PowerShell pass the pattern through
// verbatim, and the quotes survive to node. A glob passed to node itself needs
// test-runner glob support, which postdates the `engines.node` floor. Passing a
// directory is not an option either: the runner treats a positional as a file to
// execute. So the only form that behaves the same on every platform, shell and
// supported node version is the one that names the files it found.
//
// Naming them one by one in package.json is what this replaces: `npm test` used
// to name a single file, and any test added to the layer was silently never run.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const [layer, ...nodeArgs] = process.argv.slice(2)
if (!layer) {
  console.error('run-layer: a layer directory is required, e.g. node scripts/run-layer.mjs test/unit')
  process.exit(2)
}

const TEST_FILE = /\.test\.(?:m|c)?js$/
const files = readdirSync(layer, { withFileTypes: true })
  .filter((entry) => entry.isFile() && TEST_FILE.test(entry.name))
  .map((entry) => join(layer, entry.name))
  .sort()

if (files.length === 0) {
  // An empty layer is a mistake, not a green run: this script exists precisely
  // because a test that nobody collects looks identical to a suite that passed.
  console.error(`run-layer: no *.test.js files found in ${layer}`)
  process.exit(1)
}

const child = spawnSync(process.execPath, ['--test', ...nodeArgs, ...files], { stdio: 'inherit' })
if (child.error) {
  console.error(`run-layer: ${child.error.message}`)
  process.exit(1)
}
process.exit(child.status ?? 1)
