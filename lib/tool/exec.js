/**
 * Direct Git Bash process runner for the winbash tool.
 *
 * WHY THIS PLUGIN SPAWNS ITSELF (and not through `ctx.subprocess`):
 *
 * On Windows a console-subsystem program whose ancestors have no console makes
 * the OS allocate a real one, which Windows Terminal surfaces as a visible
 * window. The dsh server has no console, and `@deepseek-ai/dsh-subprocess-local`
 * creates the Windows Job runner (`lib/runner.js`, a node.exe console program)
 * through a plain `child_process.spawn()` call that does NOT pass
 * `windowsHide` — so every ordinary subprocess spawn pops a "node" console
 * window. Its native target launch then uses `CreateProcessW` with
 * `CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED` (1028), also without
 * `CREATE_NO_WINDOW`, so the state is never repaired further down the chain.
 *
 * `windowsHide: true` maps to `CREATE_NO_WINDOW`, and the hidden-console state
 * is inherited by the whole descendant tree. Measured on this host with a
 * console-less parent (`FreeConsole()`): spawning Git Bash WITHOUT it produced a
 * new visible `CASCADIA_HOSTING_WINDOW_CLASS` window, while spawning WITH it
 * produced none. That single flag is therefore the fix, and it is only reachable
 * from a spawner this plugin owns.
 *
 * This runner deliberately re-creates the semantics the tool promises —
 * credential-scrubbed environment, bounded tail-kept output with a full-output
 * spill file, deadline-driven tree termination, and an incremental background
 * handle — while spawning Git Bash directly. `scrubbedParentEnv` is imported
 * from the public `@deepseek-ai/dsh-subprocess` interface package, whose docs
 * explicitly sanction spawners that cannot route through the service.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";

/** Model-friendly environment overrides (same set dsh-bash-local applies). */
export const ENV_OVERRIDES = {
	NO_COLOR: "1",
	TERM: "dumb",
	PAGER: "cat",
	GIT_PAGER: "cat"
};

/** Private spill roots are per-process directories under the OS tmpdir. */
const SPILL_PREFIX = "dsh-winbash-";

/** Read a Windows environment entry irrespective of its recorded casing. */
function inheritedPathValue(base) {
	for (const [key, value] of Object.entries(base)) {
		if (key.toUpperCase() === "PATH") return value;
	}
	return void 0;
}

/** Split a Windows `;`-separated PATH-style list, dropping empty entries. */
function splitPathList(value) {
	return value.split(";").filter((entry) => entry.length > 0);
}

/**
 * Derive the Git for Windows installation root from a resolved bash path.
 *
 * Both layouts Git ships are accepted: `<git>\usr\bin\bash.exe` (the real MSYS2
 * bash, preferred by the resolver) and the `<git>\bin\bash.exe` wrapper.
 * @param bashPath - absolute path of the resolved bash executable.
 * @returns the installation root used to locate MSYS and MinGW directories.
 */
/**
 * Git Bash executable resolution. Never consults PATH: on Windows a bare `bash`
 * resolves to the WSL shim (`C:\Windows\System32\bash.exe`) before any Git
 * install, and that is a different shell (which may not be installed at all). Git for
 * Windows is discovered from its well-known locations, with the real MSYS2
 * `usr\bin\bash.exe` preferred over the `bin\bash.exe` wrapper and an explicit
 * `bashPath` always winning.
 *
 * Lives here rather than in the tool module because the environment builder needs it
 * to derive the Git PATH entries, and the tool module already depends on this one.
 */
export function candidateGitBashPaths(env = process.env) {
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
/**
 * @param configured - explicit `bashPath` config; empty means auto-discover.
 * @param env - environment the well-known locations are derived from.
 * @param exists - injectable file probe, so the preference order and the
 * no-PATH-fallback contract are testable without a Git installation. Production
 * always uses the real `lstatSync` probe.
 */
export function resolveGitBashPath(configured, env = process.env, exists = candidateExists) {
	if (configured !== void 0 && configured.length > 0) {
		if (exists(configured)) return configured;
		throw new Error(`winbash: configured bashPath ${configured} does not exist`);
	}
	for (const candidate of candidateGitBashPaths(env)) {
		if (exists(candidate)) return candidate;
	}
	throw new Error("winbash: Git Bash not found. Install Git for Windows (https://git-scm.com/download/win) or set the bashPath config on the tool-winbash row. This tool deliberately never falls back to PATH `bash`, which on Windows resolves to the WSL shim rather than Git Bash.");
}

export function gitRootOf(bashPath) {
	const directory = dirname(bashPath);
	if (basename(directory).toLowerCase() !== "bin") return directory;
	const parent = dirname(directory);
	return basename(parent).toLowerCase() === "usr" ? dirname(parent) : parent;
}

/**
 * The PATH entries a real Git Bash session would carry: MSYS2 coreutils
 * (`usr\bin`), MinGW tools (`mingw64\bin`), and Git's own shims (`cmd`).
 *
 * Leaving these off PATH is why the inherited host PATH alone cannot resolve
 * `ls`, `grep`, `sed`, `awk`, `find`, `sleep`, `seq`, or `wc` inside `bash -c`:
 * a non-interactive, non-login shell never sources `/etc/profile`, so whatever
 * PATH the parent hands over is the whole story.
 *
 * @param bashPath - absolute path of the resolved bash executable.
 * @param exists - injectable directory probe.
 * @returns existing directories, in precedence order.
 */
export function gitPathEntries(bashPath, exists = existsSync) {
	const root = gitRootOf(bashPath);
	return [
		join(root, "usr", "bin"),
		join(root, "mingw64", "bin"),
		join(root, "cmd")
	].filter((entry) => exists(entry));
}

/** Case-insensitive PATH de-duplication that keeps first-seen order. */
function dedupePathList(entries) {
	const seen = /* @__PURE__ */ new Set();
	const ordered = [];
	for (const raw of entries) {
		const entry = raw.replace(/[\\/]+$/, "");
		if (entry.length === 0) continue;
		const key = entry.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		ordered.push(entry);
	}
	return ordered;
}

/**
 * Compose the child PATH in native (Windows) form: explicit `extraPath` entries,
 * then Git's own directories, then the inherited host PATH. MSYS2 converts the
 * inherited value itself, so the plugin must not pre-convert it.
 *
 * @param options - inherited value, resolved bash path, and the two config knobs.
 * @returns the composed PATH string.
 */
export function composePath({ inherited, bashPath, gitPathPrefix, extraPath, exists }) {
	const entries = [];
	if (extraPath.length > 0) entries.push(...splitPathList(extraPath));
	if (gitPathPrefix) entries.push(...gitPathEntries(bashPath, exists ?? existsSync));
	entries.push(...splitPathList(inherited ?? ""));
	return dedupePathList(entries).join(";");
}

/**
 * Merge overrides into a base environment. Windows environment names are
 * case-insensitive, so an override must replace every recorded casing instead of
 * leaving a shadowed duplicate behind.
 */
function withOverrides(base, overrides) {
	if (process.platform !== "win32") return {
		...base,
		...overrides
	};
	let entries = Object.entries(base);
	for (const [key, value] of Object.entries(overrides)) {
		const normalized = key.toUpperCase();
		entries = entries.filter(([name]) => name.toUpperCase() !== normalized);
		entries.push([key, value]);
	}
	return Object.fromEntries(entries);
}

/**
 * Build the complete child environment for one winbash execution: the ambient
 * parent environment with credential-shaped and `DSH_*` names scrubbed, then
 * model-friendly overrides, the trusted `DSH_*` facts, and a repaired PATH.
 *
 * @param request - resolved request carrying the bash path and `DSH_*` facts.
 * @param config - resolved plugin configuration.
 * @returns a fresh environment object safe to hand to a child spawn.
 */
export function buildEnvironment(request, config, deps = {}) {
	const base = (deps.scrubbedParentEnv ?? scrubbedParentEnv)();
	const overrides = {
		...ENV_OVERRIDES,
		...request.dshEnv
	};
	// The resolver is injectable like the other executor seams, which lets a test
	// drive PATH composition without a real install; production always uses the
	// platform resolver, which insists on Git for Windows.
	const resolveBash = deps.resolveBashPath ?? resolveGitBashPath;
	if (config.gitPathPrefix || config.extraPath.length > 0) overrides.PATH = composePath({
		inherited: inheritedPathValue(base),
		bashPath: resolveBash(request.bashPath),
		gitPathPrefix: config.gitPathPrefix,
		extraPath: config.extraPath,
		exists: deps.exists
	});
	return withOverrides(base, overrides);
}

/** Write a whole buffer to a file descriptor, tolerating short writes. */
function writeAll(fd, buffer) {
	let offset = 0;
	while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
}

/**
 * One lazily created private spill file with a hard byte ceiling.
 *
 * Writes are synchronous on purpose: the tool hands `spillPath` to the model,
 * which may read the file the moment the call returns, so the file must be
 * complete before the collector settles. Only the truncation path pays the
 * synchronous cost.
 */
function createSpillFile(streamName, maxBytes) {
	let directory;
	let path;
	let fd;
	let written = 0;
	let saturated = false;
	let closed = false;
	const open = () => {
		directory ??= mkdtempSync(join(tmpdir(), SPILL_PREFIX));
		path = join(directory, `${streamName}.log`);
		fd = openSync(path, "w");
		return fd;
	};
	return {
		get path() {
			return path;
		},
		write(text) {
			if (saturated || closed) return;
			const buffer = Buffer.from(text, "utf8");
			const handle = fd ?? open();
			if (written + buffer.length > maxBytes) {
				const room = Math.max(0, maxBytes - written);
				if (room > 0) writeAll(handle, buffer.subarray(0, room));
				written += room;
				saturated = true;
				return;
			}
			writeAll(handle, buffer);
			written += buffer.length;
		},
		close() {
			if (closed) return;
			closed = true;
			if (fd === void 0) return;
			if (saturated) {
				const marker = Buffer.from("[spill truncated: output exceeded maxSpillBytes]\n", "utf8");
				writeAll(fd, marker);
			}
			closeSync(fd);
			fd = void 0;
		}
	};
}

/**
 * Bounded collector over one output stream.
 *
 * Text is decoded through a `StringDecoder` so a multi-byte character split
 * across two data events never becomes mojibake, and the retained window is
 * trimmed on character boundaries for the same reason. Once anything is dropped,
 * the whole stream is mirrored into a private spill file: the first overflow
 * writes the complete history, and later chunks are spilled as they arrive, so
 * no byte is written twice.
 *
 * Reads never free memory; only the byte ceiling does. That keeps `readFrom`
 * offsets meaningful while bounding resident memory to roughly `maxBytes`.
 *
 * @param options - byte ceiling, spill ceiling, and the stream name.
 * @returns a collector with `push`, `readFrom`, and `finish`.
 */
export function createCollector({ maxBytes, maxSpillBytes, streamName }) {
	const decoder = new StringDecoder("utf8");
	let kept = "";
	let total = 0;
	let dropped = false;
	let spill;
	const spillFile = () => spill ??= createSpillFile(streamName, maxSpillBytes);
	const startOffset = () => total - kept.length;
	/**
	 * Drop whole characters from the front until roughly `maxBytes` remain.
	 *
	 * `excess` is a byte count while slicing counts characters. A character is at
	 * least one byte wide, so slicing away `excess` characters always removes at
	 * least `excess` bytes — but on a large multi-byte stream that naive cut can
	 * exceed the character count and empty the window entirely. Scaling the cut by
	 * the observed average character width keeps a real tail in memory, and the
	 * result is re-checked once so the window stays within one character of the
	 * ceiling. Characters are never split.
	 */
	const trim = () => {
		let bytes = Buffer.byteLength(kept, "utf8");
		if (bytes <= maxBytes) return;
		let cut = bytes - maxBytes;
		if (cut >= kept.length) cut = Math.max(0, Math.min(kept.length - 1, Math.floor(cut / (bytes / kept.length))));
		kept = kept.slice(cut);
		bytes = Buffer.byteLength(kept, "utf8");
		if (bytes > maxBytes && kept.length > 1) {
			const second = Math.max(0, Math.min(kept.length - 1, Math.floor((bytes - maxBytes) / (bytes / kept.length))));
			kept = kept.slice(second);
		}
	};
	return {
		/** Feed one raw chunk from the child stream. */
		push(chunk) {
			if (chunk.length === 0) return;
			const text = decoder.write(chunk);
			if (text.length === 0) return;
			if (dropped) spillFile().write(text);
			kept += text;
			total += text.length;
			if (Buffer.byteLength(kept, "utf8") <= maxBytes) return;
			if (!dropped) {
				dropped = true;
				spillFile().write(kept);
			}
			trim();
		},
		/**
		 * Return output from an absolute character offset.
		 *
		 * `lossy` reports that unread output was already evicted from memory; the
		 * spill path then carries the complete stream.
		 */
		readFrom(offset) {
			const floor = startOffset();
			const from = Math.max(offset, floor);
			const text = kept.slice(from - floor);
			return {
				text,
				nextOffset: total,
				lossy: offset < floor,
				...spill !== void 0 ? { spillPath: spill.path } : {}
			};
		},
		/** Settle the collector and return the retained tail plus loss metadata. */
		finish() {
			spill?.close();
			return {
				text: kept,
				truncated: dropped,
				...spill !== void 0 ? { spillPath: spill.path } : {}
			};
		}
	};
}

/**
 * Reap one Windows process tree, hiding the taskkill console it would otherwise
 * allocate.
 *
 * `deps.spawnSync` is an injection seam for the tests, which must prove that this
 * is called only when a tree really has to die; production always uses the real
 * `node:child_process` implementation.
 *
 * @param pid - Windows process id to reap.
 * @param deps - injectable runner seam.
 */
export function taskkillTree(pid, deps = {}) {
	const run = deps?.spawnSync ?? spawnSync;
	try {
		run("taskkill", [
			"/PID",
			String(pid),
			"/T",
			"/F"
		], {
			stdio: "ignore",
			windowsHide: true
		});
	} catch {}
}

/** Live direct children, so a host exit can reap them instead of orphaning them. */
const liveChildren = /* @__PURE__ */ new Set();

/**
 * Terminate every live winbash child.
 *
 * @param deps - injected seams: `spawnSync` for the tree reaper and `platform`
 * for the branch that selects it, both of which a test needs to drive the kill
 * policy without depending on the machine it runs on.
 */
export function terminateLiveChildren(deps = {}) {
	const platform = deps?.platform ?? process.platform;
	for (const child of [...liveChildren]) {
		if (child.pid === void 0) continue;
		if (platform === "win32") taskkillTree(child.pid, deps);
		else try {
			child.kill("SIGKILL");
		} catch {}
	}
}

/**
 * The signal names a teardown watcher may be installed for, by platform.
 *
 * Windows has no signals: the listeners node does call are the console events it
 * maps, Ctrl+C to `SIGINT` and Ctrl+Break to `SIGBREAK`. `SIGTERM` can be listened
 * for there but is never delivered, so watching it would install a handler that
 * cannot run; it stays on the platforms where it is a real signal.
 *
 * @param platform - the value the executor seams carry (`process.platform` in
 * production, injected in a test).
 */
export function teardownSignals(platform) {
	return platform === "win32" ? [
		"SIGINT",
		"SIGBREAK"
	] : [
		"SIGINT",
		"SIGTERM"
	];
}

/**
 * Hooks that keep a winbash child from outliving this process, returning the
 * disposer that removes them again.
 *
 * The `exit` hook covers a normal shutdown and an explicit `process.exit()`, but it
 * does not cover a host killed by a signal: node applies a signal's default action
 * without running exit hooks, and that is how a console-hosted `dsh` dies on Ctrl+C.
 * The deliverable signals therefore get a handler here as well, so that the trees
 * this plugin starts are reaped by its own code rather than by whatever the OS
 * happens to contain.
 *
 * The handler still keeps its hands off the host's shutdown decision. When some
 * other listener also has the signal (the host's own graceful stop), it stays in
 * charge and the `exit` hook does the reaping, so nothing is torn down early and no
 * listener sees a second, spurious signal. Only when this plugin is the sole reason
 * the signal was intercepted does it reap the children, remove its own handler, and
 * end the process — which it then has to do itself, because installing the handler is
 * what removed the default action. Off Windows it re-raises the same signal, so node
 * terminates the process exactly as it would have without the plugin. On Windows
 * there is no signal to hand back: node maps `SIGINT`, `SIGTERM` and `SIGKILL` onto
 * one unconditional termination and rejects every other name, so this ends the
 * process through `SIGKILL`. Measured, that death is a forced one: the process stops
 * where it is, with exit code 1, and no exit hook of it runs — so nothing here claims
 * a graceful shutdown.
 *
 * Of the two Windows names, `SIGBREAK` was measured end to end on a Windows host: a
 * console break does call the listener, and the reaper it ran cleared a descendant
 * the break itself left alive. `SIGINT` rests on node's documented Ctrl+C mapping; a
 * scripted Ctrl+C was not observable here, so that leg is tested as a decision —
 * which watcher exists, with which arguments — and not as a reproduced signal.
 *
 * A real SIGKILL, or `taskkill /F` against the host, or a power loss runs no handler
 * at all, so no in-process hook can close that case; it needs OS-level containment.
 * A direct child already has some of that, because libuv puts every child this module
 * spawns into its own kill-on-close Job Object — a host measured to exit with no
 * hook installed still lost its bash child — and a descendant outside that
 * containment was measured to outlive its host until a whole-tree kill reached it.
 * Owning containment for everything a command may start is what the harness
 * `ctx.subprocess` seam adds and what this runner gives up to own the
 * hidden-console fix; see the header of this module.
 *
 * @param target - process-like object to hook; tests pass a fake emitter.
 * @param deps - seams forwarded to `terminateLiveChildren`, plus `platform`, which
 * selects both the watched names and the way the process is ended.
 * @returns a function that removes every hook this installed.
 */
export function installChildTeardown(target = process, deps = {}) {
	const teardown = () => terminateLiveChildren(deps);
	const platform = deps?.platform ?? process.platform;
	target.prependListener("exit", teardown);
	const signals = [];
	for (const signal of teardownSignals(platform)) {
		const handler = () => {
			if (target.listenerCount(signal) > 1) return;
			teardown();
			target.removeListener(signal, handler);
			try {
				target.kill(target.pid, platform === "win32" ? "SIGKILL" : signal);
			} catch {}
		};
		target.on(signal, handler);
		signals.push({
			signal,
			handler
		});
	}
	return () => {
		target.removeListener("exit", teardown);
		for (const { signal, handler } of signals) target.removeListener(signal, handler);
	};
}

/** Resolve once a child stdio stream has ended (or can produce nothing more). */
function onceEnded(stream) {
	return new Promise((resolve) => {
		if (stream.readableEnded || stream.destroyed) {
			resolve();
			return;
		}
		const settle = () => {
			stream.off("end", settle);
			stream.off("close", settle);
			stream.off("error", settle);
			resolve();
		};
		stream.once("end", settle);
		stream.once("close", settle);
		stream.once("error", settle);
	});
}

/**
 * Spawn one Git Bash command.
 *
 * `windowsHide: true` is the point of this whole module: without it the child
 * allocates a visible console window on a console-less host.
 *
 * The returned `closed` promise settles on the child's `exit` event, NOT on
 * `close`. Measured behaviour on Windows: once the direct child is terminated the
 * stdio pipes are not reliably closed — `close` never fired for a `taskkill /T /F`
 * kill when a grandchild had inherited the pipes, nor for a plain
 * `child.kill()` — and awaiting it hangs a timed-out call forever. Exit facts are
 * therefore authoritative, and output is drained on a bounded timer so the
 * streams still settle when EOF never arrives.
 *
 * @param request - resolved bash path, command, workdir, `DSH_*` facts.
 * @param config - resolved plugin configuration.
 * @param signal - optional abort signal; aborting terminates the tree.
 * @returns a live handle with collectors, exit promise, and `kill`.
 */
export function spawnBash(request, config, signal, deps = {}) {
	const spawnImpl = deps.spawn ?? spawn;
	const platform = deps.platform ?? process.platform;
	const maxBytes = config.maxOutputBytes;
	const stdout = createCollector({
		maxBytes,
		maxSpillBytes: config.maxSpillBytes,
		streamName: "stdout"
	});
	const stderr = createCollector({
		maxBytes,
		maxSpillBytes: config.maxSpillBytes,
		streamName: "stderr"
	});
	const child = spawnImpl(request.bashPath, ["-c", request.command], {
		...request.workdir !== void 0 ? { cwd: request.workdir } : {},
		env: buildEnvironment(request, config, deps),
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		windowsHide: true
	});
	liveChildren.add(child);
	child.stdout.on("data", (chunk) => stdout.push(chunk));
	child.stderr.on("data", (chunk) => stderr.push(chunk));
	let done = false;
	const closed = new Promise((resolve) => {
		// Releasing the two pipe sockets on settle is what lets the HOST exit: a
		// settled run used to leave `Socket,Socket,ChildProcess` in the event loop,
		// so a process that only runs winbash commands never drained. The old test
		// harness hid this by calling process.exit() in its epilogue.
		const release = () => {
			for (const stream of [
				child.stdout,
				child.stderr
			]) {
				try {
					stream?.destroy();
				} catch {}
			}
		};
		const settle = (outcome) => {
			if (done) return;
			done = true;
			release();
			resolve(outcome);
		};
		child.once("error", (error) => settle({ spawnError: error }));
		child.once("exit", (exitCode, childSignal) => {
			const outcome = {
				exitCode,
				signal: childSignal
			};
			const drain = setTimeout(() => settle(outcome), config.drainMs);
			drain.unref?.();
			Promise.all([onceEnded(child.stdout), onceEnded(child.stderr)]).then(() => {
				clearTimeout(drain);
				settle(outcome);
			});
		});
	});
	const kill = () => {
		if (child.pid === void 0) return;
		// `taskkill /T /F` is the whole-tree kill; SIGKILL afterwards only reaches the
		// direct child, so it is an escalation for a tree that somehow survived, not a
		// substitute. It is cleared as soon as the run settles, because a child that
		// exited on its own needs no escalation and an armed timer is a stray signal.
		const escalation = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
		}, config.graceMs);
		escalation.unref?.();
		closed.then(() => clearTimeout(escalation));
		if (platform === "win32") {
			taskkillTree(child.pid, deps);
			return;
		}
		try {
			child.kill("SIGTERM");
		} catch {}
	};
	const onAbort = () => kill();
	if (signal !== void 0) {
		if (signal.aborted) kill();
		else {
			signal.addEventListener("abort", onAbort, { once: true });
			closed.then(() => signal.removeEventListener("abort", onAbort));
		}
	}
	return {
		pid: child.pid,
		stdout,
		stderr,
		closed: closed.finally(() => {
			liveChildren.delete(child);
		}),
		kill
	};
}

/**
 * Foreground run: spawn, await the tree, and collect both streams. Never rejects
 * for a nonzero exit; spawn failures travel as `spawnError` and are reported by
 * the caller.
 *
 * @param request - resolved request.
 * @param config - resolved plugin configuration.
 * @param signal - deadline signal combining the caller abort and the timeout.
 * @returns exit facts plus both settled streams.
 */
export async function runBash(request, config, signal, deps = {}) {
	const handle = spawnBash(request, config, signal, deps);
	const outcome = await handle.closed;
	return {
		...outcome,
		stdout: handle.stdout.finish(),
		stderr: handle.stderr.finish()
	};
}

/**
 * Background start: returns immediately with a live handle whose `done` settles
 * at process close (spawn failures settle as killed, never reject) and whose
 * `readOutput` yields only the output produced since the previous read.
 *
 * @param request - resolved request.
 * @param config - resolved plugin configuration.
 * @param signal - caller abort signal.
 * @returns the background process handle.
 */
export function startBash(request, config, signal, deps = {}) {
	const handle = spawnBash(request, config, signal, deps);
	let stdoutOffset = 0;
	let stderrOffset = 0;
	let spawnFailureNote;
	const proc = {
		status: "running",
		exitCode: null,
		signal: null,
		done: handle.closed.then((outcome) => {
			if (proc.status === "running") proc.status = outcome.spawnError !== void 0 || outcome.signal !== null ? "killed" : "completed";
			proc.exitCode = outcome.exitCode ?? null;
			proc.signal = outcome.signal ?? null;
			if (outcome.spawnError !== void 0) spawnFailureNote = `spawn failed: ${String(outcome.spawnError)}`;
		}),
		readOutput: () => {
			const out = handle.stdout.readFrom(stdoutOffset);
			const err = handle.stderr.readFrom(stderrOffset);
			stdoutOffset = out.nextOffset;
			stderrOffset = err.nextOffset;
			const errText = err.text.length > 0 ? err.text : (spawnFailureNote ?? "");
			const separator = out.text.length > 0 && !out.text.endsWith("\n") ? "\n" : "";
			return {
				delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ""),
				lossy: out.lossy || err.lossy,
				...out.spillPath !== void 0 ? { stdoutSpillPath: out.spillPath } : {},
				...err.spillPath !== void 0 ? { stderrSpillPath: err.spillPath } : {}
			};
		},
		kill: () => {
			if (proc.status !== "running") return false;
			proc.status = "killed";
			handle.kill();
			return true;
		}
	};
	return proc;
}
