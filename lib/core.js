// Resolve the host's core packages from the running dsh instead of from this
// plugin's own dependencies.
//
// Why this exists:
// While these packages were declared as ordinary dependencies, pnpm installed a
// second copy of them into the profile, resolved to whatever was newest inside
// the declared range (`^0.1.5-0 || ^0.1.6-0 || ^0.1.7-0 || ^0.2.0-0`) — which
// is not necessarily the version the runtime is actually running.
//
// That matters because the core packages pin **each other** with exact versions
// (`"@deepseek-ai/dsh-agent": "0.2.1-rc.2"`, no caret, no tilde). A copy whose
// version differs from the runtime's by even a prerelease suffix is judged
// incompatible: dsh disables the `tools` row, and every plugin waiting on
// `tools` — the required agent loop among them — stalls forever. The profile
// then fails to boot. The failure is not a crash in this plugin; it is this
// plugin's dependency copy being the wrong version.
//
// The runtime's own copy cannot drift, because it ships inside dsh. Resolving
// from it takes the version contract out of the profile entirely: no second
// copy is installed, so there is nothing for dsh to judge, and no version to
// keep in sync after an upgrade.
//
// Resolution order deliberately puts the runtime first. Falling back to this
// package's own resolution keeps the plugin working in trees where the host
// cannot be located (tests, and installs that still carry a profile copy), but
// a profile copy must never win over the runtime's — that is the drift this
// module exists to avoid.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cache = new Map();

// The dsh entry file. `process.argv[1]` is it when dsh launched this process
// directly; otherwise fall back to the profile's dsh copy, which is what a
// plugin tree resolves against. Both are display paths, never executed here.
export const dshBinPath = () => {
	const argv1 = process.argv[1] || "";
	if (argv1 && /bin\.js$/.test(argv1) && fs.existsSync(argv1)) return argv1;
	const home = (process.env.DSH_HOME || "").trim() || path.join(os.homedir(), ".dsh");
	const profileBin = path.join(home, "profiles", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
	return fs.existsSync(profileBin) ? profileBin : "";
};

const fromRuntime = async (spec) => {
	const bin = dshBinPath();
	if (!bin) return null;
	try {
		const resolved = createRequire(bin).resolve(spec);
		return await import(pathToFileURL(resolved).href);
	} catch {
		return null;
	}
};

const fromSelf = async (spec) => {
	try {
		return await import(spec);
	} catch {
		return null;
	}
};

// Interop: a resolved module may be CJS, in which case named exports live on
// `default`. Fold them in without overwriting real named bindings.
const flatten = (mod) => {
	if (!mod) return null;
	const flat = { ...mod };
	const fallback = mod.default;
	if (fallback && typeof fallback === "object") {
		for (const key of Object.keys(fallback)) {
			if (!(key in flat)) flat[key] = fallback[key];
		}
	}
	return flat;
};

/**
 * Resolve one core package, asserting the symbols this plugin needs are there.
 * A missing symbol is reported by name: a bare `undefined` would surface much
 * later as "defineTool is not a function" inside a tool call.
 */
export async function resolveCore(spec, symbols = []) {
	const cached = cache.get(spec);
	if (cached) return cached;
	const mod = flatten((await fromRuntime(spec)) || (await fromSelf(spec)));
	if (!mod) {
		throw new Error(
			`dsh-unsandboxed-winbash: cannot resolve ${spec} — neither the running dsh ` +
				`(${dshBinPath() || "not located"}) nor this package provides it.`
		);
	}
	const missing = symbols.filter((name) => typeof mod[name] === "undefined");
	if (missing.length) {
		throw new Error(`dsh-unsandboxed-winbash: ${spec} does not export ${missing.join(", ")}.`);
	}
	cache.set(spec, mod);
	return mod;
}

// Test seam: the cache would otherwise make a second test observe the first
// test's resolution.
export const resetCoreCache = () => cache.clear();
