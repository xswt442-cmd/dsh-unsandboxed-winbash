// End-to-end tests for the direct Git Bash executor: these SPAWN Git Bash and write
// spill files under the OS tmpdir, so they need an unsandboxed shell (the dsh file
// sandbox refuses both):
//
//   winbash -c 'cd /e/.codes/createhelper/dsh-unsandboxed-winbash && node test/exec.test.mjs'
//
// The pure half is test/unit.test.mjs.
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

const BASH = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
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
		console.log(`  ok   ${label}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL ${label}${detail === void 0 ? "" : ` — ${detail}`}`);
}
function section(title) {
	console.log(`\n# ${title}`);
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
section("end-to-end: PATH repair makes POSIX tools resolve");
const pathProbe = await runBash(request("command -v ls && command -v sleep && command -v grep && command -v sed && command -v awk && command -v find && command -v wc && echo ALL-RESOLVED"), BASE_CONFIG);
check("exit code 0", pathProbe.exitCode === 0, JSON.stringify(pathProbe));
check("ls/sleep/grep/sed/awk/find/wc all resolve", pathProbe.stdout.text.includes("ALL-RESOLVED"), pathProbe.stdout.text + pathProbe.stderr.text);
check("no spill for small output", pathProbe.stdout.truncated === false);

section("end-to-end: exit status and stderr");
const failing = await runBash(request("echo to-stdout; echo to-stderr 1>&2; exit 7"), BASE_CONFIG);
check("exit code reported", failing.exitCode === 7, String(failing.exitCode));
check("stdout captured", failing.stdout.text.trim() === "to-stdout", JSON.stringify(failing.stdout.text));
check("stderr captured", failing.stderr.text.trim() === "to-stderr", JSON.stringify(failing.stderr.text));
const notFound = await runBash(request("definitely-not-a-command-xyz"), BASE_CONFIG);
check("command-not-found surfaces as exit 127", notFound.exitCode === 127, String(notFound.exitCode));

section("end-to-end: workdir");
const cwdRun = await runBash(request("pwd", { workdir: "E:\\.codes\\createhelper\\winbash" }), BASE_CONFIG);
check("workdir honored", /createhelper\/winbash/.test(cwdRun.stdout.text), cwdRun.stdout.text);

section("end-to-end: truncation spills the full output");
const noisy = await runBash(request("for i in $(seq 1 4000); do echo line-$i; done"), { ...BASE_CONFIG, maxOutputBytes: 2048 });
check("truncation reported", noisy.stdout.truncated === true);
check("spill path published", typeof noisy.stdout.spillPath === "string" && existsSync(noisy.stdout.spillPath));
const spilled = readFileSync(noisy.stdout.spillPath, "utf8");
check("spill carries output the window dropped", spilled.includes("line-1") && spilled.includes("line-4000"));
check("window keeps the tail", noisy.stdout.text.includes("line-4000"), noisy.stdout.text.slice(-60));

section("end-to-end: timeout kills the whole tree");
const bgDeadline = deadline(void 0, 1500, "BASH_TIMEOUT");
const treeStarted = Date.now();
const treeRun = spawnBash(request("/usr/bin/sleep 300 & echo BGPID=$!; wait"), BASE_CONFIG, bgDeadline.signal);
const raceOutcome = await Promise.race([
	treeRun.closed.then(() => "settled"),
	new Promise((resolve) => {
		const timer = setTimeout(() => resolve("hung"), 15000);
		timer.unref?.();
	})
]);
check("kill path settles on `exit` (awaiting `close` hangs on Windows)", raceOutcome === "settled", "closed() never resolved");
if (raceOutcome === "hung") treeRun.kill();
const treeElapsed = Date.now() - treeStarted;
check("timed-out call returns promptly", treeElapsed < 12000, `${treeElapsed}ms`);
const treeText = treeRun.stdout.finish().text;
const bgPid = Number(/BGPID=(\d+)/.exec(treeText)?.[1]);
check("output produced before the kill is still delivered", treeText.includes("BGPID="), JSON.stringify(treeText));
check("timeout classified", timeoutOf(bgDeadline.signal, "BASH_TIMEOUT") !== void 0);
check("grandchild tree is really gone", bgPid > 0 && waitForDeath(bgPid, 4000), `pid ${bgPid}`);
bgDeadline[Symbol.dispose]?.();

section("end-to-end: abort terminates the run");
const controller = new AbortController();
const abortDeadline = deadline(controller.signal, 60000, "BASH_TIMEOUT");
const abortStarted = Date.now();
const abortRun = spawnBash(request("/usr/bin/sleep 300"), BASE_CONFIG, abortDeadline.signal);
setTimeout(() => controller.abort(), 700);
await abortRun.closed;
check("abort ends the run quickly", Date.now() - abortStarted < 10000, `${Date.now() - abortStarted}ms`);
check("abort is not reported as a timeout", timeoutOf(abortDeadline.signal, "BASH_TIMEOUT") === void 0);
abortDeadline[Symbol.dispose]?.();

section("end-to-end: background handle");
const bg = startBash(request("echo first; /usr/bin/sleep 4; echo second"), BASE_CONFIG, void 0);
await new Promise((resolve) => setTimeout(resolve, 1200));
const firstRead = bg.readOutput();
check("first read sees early output", firstRead.delta.includes("first"), JSON.stringify(firstRead.delta));
check("first read excludes later output", !firstRead.delta.includes("second"), JSON.stringify(firstRead.delta));
const killed = bg.kill();
check("kill accepted while running", killed === true);
await bg.done;
check("status settles as killed", bg.status === "killed", bg.status);
check("second kill is a no-op", bg.kill() === false);
const bgAgain = startBash(request("echo done"), BASE_CONFIG, void 0);
await bgAgain.done;
check("clean exit settles as completed", bgAgain.status === "completed", bgAgain.status);
check("exit code reported", bgAgain.exitCode === 0, String(bgAgain.exitCode));

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);


console.log(`\n${passed} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
