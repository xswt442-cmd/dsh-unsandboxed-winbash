// Pure unit tests for the Git Bash executor (PATH composition, environment scrubbing, bounded collector).
// Nothing here spawns a process, so this suite runs anywhere, including inside
// the dsh file sandbox where SPAWNING is what a restricted token refuses.
//
//   node --test test/unit.test.mjs
//
// The spawning half is test/exec.test.mjs and needs an unsandboxed shell.
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
section("gitRootOf");
check("usr\\bin layout", gitRootOf("C:\\Program Files\\Git\\usr\\bin\\bash.exe") === "C:\\Program Files\\Git", gitRootOf("C:\\Program Files\\Git\\usr\\bin\\bash.exe"));
check("bin wrapper layout", gitRootOf("C:\\Program Files\\Git\\bin\\bash.exe") === "C:\\Program Files\\Git", gitRootOf("C:\\Program Files\\Git\\bin\\bash.exe"));
check("ProgramFiles(x86) layout", gitRootOf("C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe") === "C:\\Program Files (x86)\\Git");

section("composePath");
const composed = composePath({
	inherited: "C:\\Windows;C:\\Windows\\System32;C:\\tools",
	bashPath: BASH,
	gitPathPrefix: true,
	extraPath: "D:\\extra",
	exists: () => true
});
check("extra entries come first", composed.startsWith("D:\\extra;"), composed);
check("MSYS coreutils precede the host PATH", composed.indexOf("usr\\bin") < composed.indexOf("C:\\Windows;"), composed);
check("host PATH is preserved at the tail", composed.endsWith("C:\\Windows;C:\\Windows\\System32;C:\\tools"), composed);
const deduped = composePath({
	inherited: "C:\\tools;C:\\Tools;C:\\tools\\",
	bashPath: BASH,
	gitPathPrefix: false,
	extraPath: "",
	exists: () => true
});
check("case-insensitive de-duplication", deduped === "C:\\tools", deduped);
const noPrefix = composePath({
	inherited: "C:\\Windows",
	bashPath: BASH,
	gitPathPrefix: false,
	extraPath: "",
	exists: () => true
});
check("gitPathPrefix=false leaves PATH untouched", noPrefix === "C:\\Windows", noPrefix);

section("buildEnvironment");
const env = buildEnvironment(request("true"), BASE_CONFIG);
check("PATH carries Git's usr\\bin", typeof env.PATH === "string" && /usr\\bin/i.test(env.PATH), env.PATH);
check("exactly one PATH-ish key survives", Object.keys(env).filter((key) => key.toUpperCase() === "PATH").length === 1, Object.keys(env).filter((key) => key.toUpperCase() === "PATH").join(","));
check("NO_COLOR override applied", env.NO_COLOR === "1");
check("TERM override applied", env.TERM === "dumb");
check("trusted DSH_* fact forwarded", env.DSH_SHELL === "1");
check("credential-shaped names scrubbed", Object.keys(env).every((key) => !/KEY|PASSWORD|SECRET|TOKEN/i.test(key)));

section("spawn options (popup regression guard)");
let captured;
const fakeChild = {
	pid: 4242,
	stdout: { on() {} },
	stderr: { on() {} },
	once(event, handler) {
		if (event === "close") setImmediate(() => handler(0, null));
	},
	kill() {}
};
spawnBash(request("true"), BASE_CONFIG, void 0, {
	spawn: (file, args, options) => {
		captured = { file, args, options };
		return fakeChild;
	},
	scrubbedParentEnv: () => ({ PATH: "C:\\Windows" }),
	exists: () => true
});
check("windowsHide is set — CREATE_NO_WINDOW is the whole fix", captured.options.windowsHide === true, JSON.stringify(captured.options.windowsHide));
check("bash is invoked as `bash -c <command>`", captured.args[0] === "-c" && captured.args[1] === "true", JSON.stringify(captured.args));
check("stdin is ignored, both streams piped", JSON.stringify(captured.options.stdio) === '["ignore","pipe","pipe"]', JSON.stringify(captured.options.stdio));

section("createCollector");
const collector = createCollector({ maxBytes: 64, maxSpillBytes: 1 << 20, streamName: "stdout" });
for (let index = 0; index < 10; index += 1) collector.push(Buffer.from(`chunk-${index}-${"x".repeat(20)}\n`, "utf8"));
const settled = collector.finish();
check("overflow is reported", settled.truncated === true);
check("retained window stays bounded", Buffer.byteLength(settled.text, "utf8") <= 64 + 40, String(Buffer.byteLength(settled.text, "utf8")));
check("the tail is what survives", settled.text.includes("chunk-9"), settled.text);
check("spill path published", typeof settled.spillPath === "string" && existsSync(settled.spillPath), settled.spillPath);
check("spill holds the complete stream", readFileSync(settled.spillPath, "utf8").includes("chunk-0") && readFileSync(settled.spillPath, "utf8").includes("chunk-9"));
const multibyte = createCollector({ maxBytes: 16, maxSpillBytes: 1 << 20, streamName: "stdout" });
multibyte.push(Buffer.from("中文中文中文中文中文中文", "utf8"));
const mbSettled = multibyte.finish();
check("multi-byte trim never produces replacement characters", !mbSettled.text.includes("\uFFFD"), JSON.stringify(mbSettled.text));
check("multi-byte trim keeps a tail instead of collapsing the window", mbSettled.text.length > 0 && "中文中文中文中文中文中文".endsWith(mbSettled.text), JSON.stringify(mbSettled.text));
const huge = createCollector({ maxBytes: 4096, maxSpillBytes: 1 << 20, streamName: "stdout" });
for (let index = 0; index < 400; index += 1) huge.push(Buffer.from(`行${index}-${"宽".repeat(40)}\n`, "utf8"));
const hugeSettled = huge.finish();
check("dense multi-byte output still retains a usable tail", hugeSettled.text.length > 0 && hugeSettled.text.includes("行399-"), `${hugeSettled.text.length} chars`);
check("dense multi-byte window stays bounded", Buffer.byteLength(hugeSettled.text, "utf8") <= 4096 + 8, String(Buffer.byteLength(hugeSettled.text, "utf8")));
check("dense multi-byte spill keeps everything", readFileSync(hugeSettled.spillPath, "utf8").includes("行0-") && readFileSync(hugeSettled.spillPath, "utf8").includes("行399-"));


console.log(`\n${passed} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
