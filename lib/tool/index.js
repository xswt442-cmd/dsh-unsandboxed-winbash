import z from "@deepseek-ai/schemastery";
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { TOOL_ABORTED, defineTool } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { parseExitStatus } from "@deepseek-ai/dsh-shell";
import { clampTimeout, deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { runBash, startBash, terminateLiveChildren } from "./exec.js";
//#region lib/types/resolve.js
/**
 * Git Bash executable resolution. Never consults PATH: on Windows a bare
 * `bash` resolves to the WSL shim (`C:\Windows\System32\bash.exe`) before any
 * Git install, and that is a different shell (and may not be installed at
 * all). Git for Windows is discovered from its well-known install locations,
 * newest-first, with an explicit `bashPath` config always winning.
 *
 * `usr\bin\bash.exe` (the real MSYS2 bash) is preferred over the `bin\bash.exe`
 * wrapper: the wrapper re-launches bash, and the plugin derives the MSYS and
 * MinGW PATH entries from whichever layout it resolves.
 *
 * @module @deepseek-ai/dsh-winbash/resolve
 */
function candidateGitBashPaths(env = process.env) {
	const programFiles = env.ProgramFiles ?? "C:\\Program Files";
	const programFilesX86 = env["ProgramFiles(x86)"] ?? programFiles;
	const localAppData = env.LOCALAPPDATA ?? "";
	return [
		join(programFiles, "Git", "usr", "bin", "bash.exe"),
		join(programFiles, "Git", "bin", "bash.exe"),
		join(localAppData, "Programs", "Git", "usr", "bin", "bash.exe"),
		join(localAppData, "Programs", "Git", "bin", "bash.exe"),
		join(programFilesX86, "Git", "usr", "bin", "bash.exe"),
		join(programFilesX86, "Git", "bin", "bash.exe")
	];
}
function candidateExists(candidate) {
	try {
		const stat = lstatSync(candidate);
		return stat.isFile() || stat.isSymbolicLink();
	} catch {
		return false;
	}
}
function resolveGitBashPath(configured, env = process.env) {
	if (configured !== void 0 && configured.length > 0) {
		if (candidateExists(configured)) return configured;
		throw new Error(`winbash: configured bashPath ${configured} does not exist`);
	}
	for (const candidate of candidateGitBashPaths(env)) {
		if (candidateExists(candidate)) return candidate;
	}
	throw new Error("winbash: Git Bash not found. Install Git for Windows (https://git-scm.com/download/win) or set the bashPath config on the tool-winbash row. This tool deliberately never falls back to PATH `bash`, which on Windows resolves to the WSL shim rather than Git Bash.");
}
//#endregion
//#region lib/types/render.js
/**
 * Model-facing result rendering for the winbash tool: stdout, then a marked
 * stderr section, then exit-status markers. Non-zero exits are reported, not
 * errored — the model decides how to react; only infrastructure failures
 * (spawn errors, aborts) surface as isError results.
 *
 * @module @deepseek-ai/dsh-winbash/tool/render
 */
function streamText(output) {
	if (!output.truncated) return output.text;
	return `${output.text}\n[output truncated; full output: ${output.spillPath ?? "(unavailable)"}]`;
}
function renderResult(result) {
	const out = streamText(result.stdout);
	const err = streamText(result.stderr);
	let body = out;
	if (err.length > 0) {
		if (body.length > 0 && !body.endsWith("\n")) body += "\n";
		body += `[stderr]\n${err}`;
	}
	if (body.length === 0) body = "(no output)";
	const markers = [];
	if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`);
	if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`);
	else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`);
	if (markers.length === 0) return body;
	if (!body.endsWith("\n")) body += "\n";
	return body + markers.join("\n");
}
function renderProcessRead(read) {
	const notices = [];
	if (read.lossy) {
		const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path) => path !== void 0);
		notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(", ") : "(unavailable)"}]`);
	}
	if (notices.length === 0) return read.delta;
	return `${read.delta}${read.delta.length > 0 && !read.delta.endsWith("\n") ? "\n" : ""}${notices.join("\n")}`;
}
//#endregion
//#region lib/types/index.js
/**
 * Small additive Git Bash tool for Windows. Runs `bash -c` through Git Bash
 * using the plugin's own spawner, WITHOUT replacing `ctx.shell`: the pwsh tool,
 * the permission presets, and the file sandbox all stay exactly as composed.
 *
 * The tool also does not route through `ctx.subprocess`. That seam's Windows Job
 * runner is created by a `child_process.spawn()` without `windowsHide`, so a
 * console-less host gets a real, visible console window ("node terminal") for
 * every ordinary spawn; the hidden-console flag is only reachable from a spawner
 * this plugin owns. See `lib/tool/exec.js` for the measurement behind that.
 *
 * The tool itself stays unconfined (Git Bash's MSYS runtime cannot start under
 * the Windows ACL restricted token), so it exposes no `sandbox_permissions`
 * surface and its description says so.
 *
 * @module @deepseek-ai/dsh-winbash/tool
 */
const name = "tool-winbash";
const inject = [
	"tools",
	"systemPrompt",
	"shellEnv"
];
/** Runtime configuration schema for the winbash tool plugin. */
const Config = z.object({
	enableRunInBackground: z.boolean().default(true),
	bashPath: z.string().default(""),
	gitPathPrefix: z.boolean().default(true),
	extraPath: z.string().default(""),
	timeoutMs: z.number().default(12e4),
	maxTimeoutMs: z.number().default(6e5),
	maxOutputBytes: z.number().default(64e3),
	maxSpillBytes: z.number().default(64 * 1024 * 1024),
	graceMs: z.number().default(3e3),
	drainMs: z.number().default(250)
});
function validateWinbashArgs(args) {
	if (args.command.trim().length === 0) throw new Error("invalid command: expected a non-empty string");
	if (args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");
	if (args.timeoutMs !== void 0 && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`);
}
function winbashDescription(backgroundEnabled) {
	const background = backgroundEnabled ? "Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`." : "Background execution is not available; long-running commands must finish within the timeout.";
	return `Execute a bash command through Git Bash on Windows (\`bash -c\`) and return its stdout/stderr. Each call runs in a fresh bash process: no state (cwd, variables, functions) persists between calls — pass \`workdir\` instead of using \`cd\`. The dialect is Git Bash (MSYS2): POSIX tools (\`ls\`, \`grep\`, \`sed\`, \`awk\`, \`find\`, \`curl\`, ...) are available because the tool puts Git's own \`usr\\bin\`, \`mingw64\\bin\`, and \`cmd\` directories on PATH ahead of the inherited host PATH; both MSYS paths (\`/c/Users/...\`) and forward-slash Windows paths (\`C:/Users/...\`) work; single-quote backslash paths (\`'C:\\\\...'\`). The tool resolves Git Bash itself — never invoke \`bash\` by name inside a command, because Windows resolves bare \`bash\` to the WSL shim. This tool is a small ADDITIVE plugin: it does not replace the pwsh tool, and it runs OUTSIDE the file-effect sandbox (Git Bash's MSYS runtime cannot start under the Windows ACL restricted token), so there is no \`sandbox_permissions\` surface and destructive commands are NOT confined — prefer the fs tools for file changes and keep winbash read-only where possible. Non-zero exits are reported as \`[exit code: N]\`. On Windows a force-killed process settles as \`[exit code: 1]\` without a signal marker — treat a bare exit 1 after an interruption as a termination, not a command failure. Current harness environment facts are exposed through managed \`DSH_*\` variables; inspect them when needed. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. ` + background;
}
function resolveWorkdir(modelWorkdir, exec) {
	const headerCwd = exec.agent?.session.header.cwd;
	if (modelWorkdir === void 0) return headerCwd;
	if (headerCwd !== void 0 && !isAbsolute(modelWorkdir)) return resolve(headerCwd, modelWorkdir);
	return modelWorkdir;
}
/** Canonical background-handle properties shared by the winbash output union. */
const BACKGROUND_OUTPUT_PROPERTIES = {
	kind: {
		type: "string",
		required: true,
		const: "background"
	},
	jobId: {
		type: "string",
		required: true
	}
};
function apply(ctx, config = {}) {
	const cfg = {
		enableRunInBackground: true,
		bashPath: "",
		gitPathPrefix: true,
		extraPath: "",
		timeoutMs: 12e4,
		maxTimeoutMs: 6e5,
		maxOutputBytes: 64e3,
		maxSpillBytes: 64 * 1024 * 1024,
		graceMs: 3e3,
		drainMs: 250,
		...config
	};
	const backgroundEnabled = cfg.enableRunInBackground;
	let resolvedBashPath;
	const gitBashPath = () => {
		resolvedBashPath ??= resolveGitBashPath(cfg.bashPath);
		return resolvedBashPath;
	};
	ctx.effect(() => {
		process.prependListener("exit", terminateLiveChildren);
		return () => process.off("exit", terminateLiveChildren);
	}, "winbash child teardown");
	ctx.systemPrompt.section({
		name: "tool:winbash",
		order: 105,
		text: "Check the [exit code: N] marker on every winbash result; investigate failures before moving on. winbash (Git Bash) is a small additive tool that runs OUTSIDE the file-effect sandbox — keep destructive operations deliberate and prefer the sandboxed fs tools for file changes."
	});
	ctx.tools.register(defineTool({
		name: "winbash",
		description: winbashDescription(backgroundEnabled),
		parameters: {
			command: {
				type: "string",
				required: true,
				description: "The bash command to execute (Git Bash dialect)."
			},
			description: {
				type: "string",
				required: true,
				description: "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: \"ls\" → \"List files in current directory\"; \"git status\" → \"Show working tree status\"; \"npm install\" → \"Install package dependencies\"."
			},
			timeoutMs: {
				type: "number",
				description: "Timeout in milliseconds. The tool applies its configured default and cap, and kills the command on expiry."
			},
			workdir: {
				type: "string",
				description: "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it."
			},
			...backgroundEnabled ? { run_in_background: {
				type: "boolean",
				description: "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies."
			} } : {}
		},
		output: {
			schema: { oneOf: [{
				type: "object",
				additionalProperties: false,
				properties: BACKGROUND_OUTPUT_PROPERTIES
			}, {
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true,
						const: "foreground"
					},
					exitCode: {
						required: true,
						oneOf: [{ type: "integer" }, { type: "null" }]
					},
					signal: {
						required: true,
						oneOf: [{ type: "string" }, { type: "null" }]
					},
					timedOut: {
						type: "boolean",
						required: true
					},
					aborted: {
						type: "boolean",
						required: true
					},
					timeoutMs: {
						type: "number",
						required: true
					},
					stdout: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							text: {
								type: "string",
								required: true
							},
							truncated: {
								type: "boolean",
								required: true
							},
							spillPath: { type: "string" }
						}
					},
					stderr: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							text: {
								type: "string",
								required: true
							},
							truncated: {
								type: "boolean",
								required: true
							},
							spillPath: { type: "string" }
						}
					}
				}
			}] },
			render: (_args, value) => [{
				type: "text",
				text: value.kind === "background" ? `started background job ${value.jobId}` : renderResult(value)
			}]
		},
		async execute(args, exec) {
			validateWinbashArgs(args);
			const workdir = resolveWorkdir(args.workdir, exec);
			const request = {
				bashPath: gitBashPath(),
				command: args.command,
				...workdir !== void 0 ? { workdir } : {},
				dshEnv: ctx.shellEnv.collect(exec)
			};
			if (args.run_in_background === true) {
				if (!backgroundEnabled) throw new Error("run_in_background is disabled for this deployment (enableRunInBackground: false)");
				const jobs = ctx.get("jobs");
				if (jobs === void 0) throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
				if (exec.signal.aborted) {
					const error = new HarnessError("tool call aborted", TOOL_ABORTED);
					error.name = "AbortError";
					throw error;
				}
				return {
					kind: "background",
					jobId: jobs.start({
						kind: "winbash",
						label: args.command,
						...exec.agent ? { owner: exec.agent } : {},
						run: () => {
							const proc = startBash(request, cfg, exec.signal);
							return {
								cancel: () => void proc.kill(),
								done: proc.done.then(() => ({
									status: proc.status === "killed" ? "killed" : "completed",
									detail: proc.status === "killed" ? proc.signal !== null ? `signal: ${proc.signal}` : "killed before exit" : `exit code: ${proc.exitCode ?? 0}`
								})),
								readOutput: () => renderProcessRead(proc.readOutput())
							};
						}
					})
				};
			}
			const timeoutMs = clampTimeout(args.timeoutMs, cfg.timeoutMs, cfg.maxTimeoutMs, "winbash: request.timeoutMs");
			const d = deadline(exec.signal, timeoutMs, "BASH_TIMEOUT");
			let result;
			try {
				result = await runBash(request, cfg, d.signal);
			} finally {
				d[Symbol.dispose]?.();
			}
			if (result.spawnError !== void 0) throw result.spawnError;
			const timedOut = timeoutOf(d.signal, "BASH_TIMEOUT") !== void 0;
			const aborted = d.signal.aborted && !timedOut;
			if (aborted) {
				const error = new HarnessError("tool call aborted", TOOL_ABORTED);
				error.name = "AbortError";
				throw error;
			}
			return {
				kind: "foreground",
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut,
				aborted,
				timeoutMs,
				stdout: result.stdout,
				stderr: result.stderr
			};
		},
		presentCall: (args) => {
			if (args.run_in_background === true) return {
				card: "generic",
				title: args.command,
				kind: "execute",
				rawInput: args.command,
				content: [{
					type: "text",
					text: args.description
				}]
			};
			return {
				card: "terminal",
				title: args.command,
				description: args.description,
				...args.workdir !== void 0 ? { cwd: args.workdir } : {}
			};
		},
		presentResult: (args, result) => {
			const block = result.content.length === 1 ? result.content[0] : void 0;
			if (block === void 0 || block.type !== "text") return void 0;
			const raw = block.text;
			if (typeof args === "object" && args !== null && args.run_in_background === true || result.isError) return {
				card: "generic",
				content: [{
					type: "text",
					text: `\`\`\`console\n${raw.replace(/\n+$/, "")}\n\`\`\``
				}]
			};
			const { body, ...exit } = parseExitStatus(raw);
			return {
				card: "terminal",
				output: body,
				...exit
			};
		}
	}));
}
//#endregion
export { Config, apply, inject, name };
