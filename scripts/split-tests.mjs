// Assemble this repo's two test suites from the original winbash assertion file,
// so the split stays reproducible instead of hand-edited.
//
//   unit.test.mjs        pure helpers only  -> runs anywhere (also inside the sandbox)
//   exec.test.mjs        spawning end-to-end -> needs an unsandboxed shell
//
// The shared prelude (imports, config, check/section/request helpers) is written
// from PRELUDE below, NOT sliced out of the original, because a slice boundary
// is exactly what produced a truncated `section()` in the first attempt.
import fs from 'node:fs'

const ORIG = '../../winbash/test/exec.test.mjs'
const DST = "test"

const src = fs.readFileSync(ORIG, 'utf8').split('\n')
// Original layout: 0..21 header+imports, 22..167 pure sections, 168..244 spawning sections.
// The section bodies are what gets reused; the harness (imports, BASE_CONFIG,
// check/section/request) is written fresh by PRELUDE, so start each body at the
// first `section(` call.
const firstSection = src.findIndex((line) => line.startsWith('section('))
if (firstSection === -1) throw new Error('no section() call found in ' + ORIG)
const allBodies = src.slice(firstSection).join('\n')
const pureBody = allBodies.split('section("end-to-end:')[0]
const spawnBody = ('section("end-to-end:' + allBodies.split('section("end-to-end:').slice(1).join('section("end-to-end:'))
  // The original hard-codes its own repo path in the workdir assertion and in the
  // run-this-way comments. Retarget both by DIRECTORY NAME, never by a literal old
  // path: the file carries escaped backslashes, so an escaped literal silently
  // matches nothing (this bit twice before).
  .split('winbash')
  .join('my-dsh-plugins/dsh-unsandboxed-winbash')
  // The workdir assertion is a regex literal, so it is replaced wholesale with a
  // separator-agnostic pattern: a plain insertion of the path would either break
  // the literal (unescaped `/`) or need regex-escaping through two string layers.
  .replace(
    /^check\("workdir honored".*$/m,
    'check("workdir honored", /my-dsh-plugins[\\\\/]dsh-unsandboxed-winbash/.test(cwdRun.stdout.text), cwdRun.stdout.text);'
  )

const B = String.fromCharCode(92)
const BASH = `C:${B}Program Files${B}Git${B}usr${B}bin${B}bash.exe`

const PRELUDE = (kind) => `// ${kind}
//
// Part of the test split that the repo documents: this file and its sibling are
// assembled from one source by scripts/split-tests.mjs, so neither is hand-edited.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import {
	buildEnvironment,
	composePath,
	createCollector,
	gitRootOf,
	runBash,
	spawnBash,
	startBash
} from "../lib/tool/exec.js";

const BASH = ${JSON.stringify(BASH)};
const BASE_CONFIG = {
	enableRunInBackground: true,
	bashPath: BASH,
	gitPathPrefix: true,
	extraPath: "",
	timeoutMs: 120000,
	maxTimeoutMs: 600000,
	maxOutputBytes: 64000,
	maxSpillBytes: 64 * 1024 * 1024,
	graceMs: 3000,
	drainMs: 250
};

let failures = 0;
let passed = 0;
function check(label, condition, detail) {
	if (condition) {
		passed += 1;
		console.log(\`  ok   \${label}\`);
		return;
	}
	failures += 1;
	console.log(\`  FAIL \${label}\${detail === void 0 ? "" : \` — \${detail}\`}\`);
}
function section(title) {
	console.log(\`\\n# \${title}\`);
}
function request(command, extra = {}) {
	return {
		bashPath: BASH,
		command,
		dshEnv: { DSH_SHELL: "1" },
		...extra
	};
}
/** True while a PID is still alive; the tree-kill assertions need it. */
function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function waitForDeath(pid, timeoutMs) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (!alive(pid)) return true;
		spawnSync(process.execPath, ["-e", "setTimeout(()=>{},60)"], { stdio: "ignore" });
	}
	return !alive(pid);
}
`

const TAIL = `
console.log(\`\\n\${passed} passed, \${failures} failed\`)
process.exit(failures === 0 ? 0 : 1)
`

// Pure suite: keep the popup-regression guard in the pure body (it stubs the
// spawner and never starts a process), so the split is not a judgement about
// which assertion belongs where.
const unitPure = pureBody
const unit = PRELUDE(
  'Pure unit tests for the Git Bash executor (PATH composition, environment scrubbing, bounded collector).\n// Nothing here spawns a process, so this suite runs anywhere, including inside\n// the dsh file sandbox where SPAWNING is what a restricted token refuses.\n//\n//   node --test test/unit.test.mjs\n//\n// The spawning half is test/exec.test.mjs and needs an unsandboxed shell.'
) + unitPure + TAIL

const integration = PRELUDE(
  'End-to-end tests for the direct Git Bash executor: these SPAWN Git Bash and write\n// spill files under the OS tmpdir, so they need an unsandboxed shell (the dsh file\n// sandbox refuses both):\n//\n//   winbash -c \'cd /e/.codes/createhelper/dsh-unsandboxed-winbash && node test/exec.test.mjs\'\n//\n// The pure half is test/unit.test.mjs.'
) + spawnBody + '\n' + TAIL

fs.mkdirSync(DST, { recursive: true })
fs.writeFileSync(DST + '/unit.test.mjs', unit)
fs.writeFileSync(DST + '/exec.test.mjs', integration)
for (const [name, text] of [['unit.test.mjs', unit], ['exec.test.mjs', integration]]) {
  const opens = (text.match(/function section\(/g) || []).length
  const calls = (text.match(/^section\(/gm) || []).length
  console.log(`${name}: ${text.split('\n').length} lines, ${calls} sections, section() defined ${opens}x`)
}
