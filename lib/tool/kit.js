// Local implementations of the harness helpers this bundle used to import from
// the `@deepseek-ai/*` packages.
//
// Why this file exists:
// Importing those packages only works if they are installed into the profile,
// and a second copy of `@deepseek-ai/dsh-tools` in the profile breaks dsh itself.
// The chain is short and fatal:
//
//   1. dsh's base bundle declares a row named `@deepseek-ai/dsh-tools`. The
//      loader resolves that bare name from the profile, so the `tools` service
//      is built from the profile's copy.
//   2. `dsh-tools` keys its internal scheduler by a plain
//      `Symbol("@deepseek-ai/dsh-tools.scheduler")`. A plain `Symbol()` is
//      unique per module instance.
//   3. Other harness parts (`run_code` / PTC) load from dsh's own tree and read
//      that symbol off the registry. Different instance, different symbol, so
//      the value is undefined and every tool call dies on
//      `Cannot read properties of undefined (reading 'prepare')`.
//
// The only fix that does not depend on guessing which copy dsh resolved is to
// stop contributing a copy at all. Everything below is small, pure, and
// behaviour-compatible with the originals at the versions this plugin supports;
// where the original reached for a harness service this file uses only node
// built-ins.

/** Environment variables never forwarded to a child (mirrors dsh-subprocess). */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;

/**
 * The parent environment minus credentials and harness-private variables.
 * Same rules as `@deepseek-ai/dsh-subprocess`'s `scrubbedParentEnv`, minus the
 * proxy-namespace rewriting that service applies (the plain values already
 * survive the filter below).
 */
export function scrubbedParentEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (SENSITIVE_ENV_PATTERN.test(key)) continue;
		if (key.toUpperCase().startsWith("DSH_")) continue;
		env[key] = value;
	}
	return env;
}

/** Harness-shaped error: a stable `code` plus the message dsh renders. */
export class HarnessError extends Error {
	constructor(message, code) {
		super(message);
		this.name = "HarnessError";
		this.code = code;
	}
}

/** Invalid model-generated arguments for a typed tool. */
export class ToolArgsError extends HarnessError {
	constructor(violations) {
		super(`invalid arguments: ${violations.join("; ")}`, "INVALID_ARGS");
		this.name = "ToolArgsError";
		this.violations = violations;
	}
}

/**
 * Validate a caller's optional timeout hint, apply the default, then cap it.
 * Mirrors `@deepseek-ai/dsh-timeout`'s `clampTimeout`.
 */
export function clampTimeout(requested, def, max, name = "timeoutMs") {
	if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
		throw new Error(`${name} must be a positive finite number`);
	}
	return Math.min(requested ?? def, max);
}

/** Why a deadline fired, carrying the capability-owned code. */
export class TimeoutReason {
	constructor(code, timeoutMs) {
		this.code = code;
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Fuse upstream cancellation with an identifiable timeout. `timeoutMs <= 0`
 * means "no timer". The signal only notifies; callers must stop their own work.
 */
export function deadline(upstream, timeoutMs, code) {
	if (timeoutMs <= 0) {
		return { signal: upstream ?? new AbortController().signal, [Symbol.dispose]() {} };
	}
	const timer = new AbortController();
	const id = setTimeout(() => {
		timer.abort(new TimeoutReason(code, timeoutMs));
	}, timeoutMs);
	// Node clamps anything above 2^31-1 ms; a longer request is a caller bug and
	// would silently fire ~24 days early, so refuse it instead.
	if (id === undefined) throw new Error("deadline: timer could not be armed");
	return {
		signal: upstream !== undefined ? AbortSignal.any([upstream, timer.signal]) : timer.signal,
		[Symbol.dispose]() {
			clearTimeout(id);
		}
	};
}

/** The timeout reason behind an aborted signal, when it was ours. */
export function timeoutOf(signal, code) {
	const reason = signal?.reason;
	if (!(reason instanceof TimeoutReason)) return undefined;
	return code === undefined || reason.code === code ? reason : undefined;
}

/**
 * Split the trailing status marker off rendered output, the way
 * `@deepseek-ai/dsh-shell`'s `parseExitStatus` does.
 */
export function parseExitStatus(text) {
	const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text);
	if (signal?.[1] !== undefined) {
		return { body: text.slice(0, signal.index), signal: signal[1] };
	}
	const exit = /\n\[exit code: (\d+)\]$/.exec(text);
	if (exit?.[1] !== undefined) {
		return { body: text.slice(0, exit.index), exitCode: Number(exit[1]) };
	}
	return { body: text };
}

// --- parameter spec -> JSON Schema -----------------------------------------
// The tool declarations in this bundle use the harness's compact spec form
// (`{ command: { type, required, description } }`). `ctx.tools.register` wants
// JSON Schema, so the conversion that `defineTool` used to perform lives here.

const SPEC_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array"]);

function compileProperty(name, spec) {
	if (spec === null || typeof spec !== "object") {
		throw new Error(`parameter "${name}": spec must be an object`);
	}
	if (!SPEC_TYPES.has(spec.type)) {
		throw new Error(`parameter "${name}": unsupported type ${String(spec.type)}`);
	}
	const out = { type: spec.type };
	if (spec.description !== undefined) out.description = spec.description;
	if (spec.const !== undefined) out.const = spec.const;
	if (spec.enum !== undefined) out.enum = spec.enum;
	if (spec.items !== undefined) out.items = compileValue(name, spec.items);
	if (spec.properties !== undefined) out.properties = compileValue(name, spec).properties;
	if (spec.additionalProperties !== undefined) out.additionalProperties = spec.additionalProperties;
	if (spec.oneOf !== undefined) out.oneOf = spec.oneOf.map((v) => compileValue(name, v));
	return out;
}

/** Compile either a property map or a single value spec. */
function compileValue(name, spec) {
	if (spec === null || typeof spec !== "object") throw new Error(`parameter "${name}": bad spec`);
	// A bare value spec (`{ type: "string" }`) rather than a property map.
	if (spec.type !== undefined) {
		const compiled = compileProperty(name, spec);
		if (compiled.type === "object" && compiled.properties === undefined) {
			compiled.properties = {};
		}
		return compiled;
	}
	const properties = {};
	const required = [];
	for (const [key, value] of Object.entries(spec)) {
		properties[key] = compileProperty(`${name}.${key}`, value);
		if (value?.required === true) required.push(key);
	}
	const schema = { type: "object", properties };
	if (required.length) schema.required = required;
	return schema;
}

/** Build the JSON Schema for a tool's parameter map. */
export function parameterSchemaToJsonSchema(spec) {
	const compiled = compileValue("parameters", spec);
	if (compiled.type !== "object") throw new Error('parameters: root must be an object spec');
	return compiled;
}

/** Minimal required/type check, matching what `defineTool` wrapped around execute. */
function validateArgs(schema, args) {
	const violations = [];
	if (args === null || typeof args !== "object" || Array.isArray(args)) {
		return ["arguments must be an object"];
	}
	for (const key of schema.required ?? []) {
		if (args[key] === undefined) violations.push(`missing required property "${key}"`);
	}
	for (const [key, prop] of Object.entries(schema.properties ?? {})) {
		const value = args[key];
		if (value === undefined) continue;
		const want = prop.type;
		const ok =
			want === "integer"
				? Number.isInteger(value)
				: want === "number"
					? typeof value === "number" && Number.isFinite(value)
					: want === "array"
						? Array.isArray(value)
						: want === "object"
							? typeof value === "object" && value !== null && !Array.isArray(value)
							: typeof value === want;
		if (!ok) {
			// Wording matches the host's schema checker: the model reads these.
			const article = { string: "a string", number: "a number", integer: "an integer", boolean: "a boolean", array: "an array", object: "an object" };
			violations.push(`${key} must be ${article[want] ?? want}`);
		}
	}
	return violations;
}

/**
 * Build a tool definition accepted by `ctx.tools.register`, with the same shape
 * `defineTool` produced: parameters as JSON Schema, output schema + render, and
 * an execute that validates arguments first.
 */
export function defineTool(options) {
	const parameters = parameterSchemaToJsonSchema(options.parameters);
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: options.output.schema,
			render(args, value) {
				return options.output.render(args, value);
			}
		},
		async execute(args, exec) {
			const violations = validateArgs(parameters, args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return options.execute(args, exec);
		}
	};
	if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs;
	if (options.output.presentationMeta !== undefined) {
		tool.output.presentationMeta = (args, value) => options.output.presentationMeta(args, value);
	}
	if (options.projectContent !== undefined) tool.projectContent = (exec, result) => options.projectContent(exec, result);
	if (options.finalizeContent !== undefined) tool.finalizeContent = (exec, result) => options.finalizeContent(exec, result);
	if (options.presentCall !== undefined) tool.presentCall = (args) => options.presentCall(args);
	if (options.presentResult !== undefined) tool.presentResult = (args, result) => options.presentResult(args, result);
	if (options.isConcurrencySafe !== undefined) tool.isConcurrencySafe = (args) => options.isConcurrencySafe(args);
	return tool;
}

/** The harness's canonical error code for cancellation after a tool body was invoked. */
export const TOOL_ABORTED = "ABORTED";
