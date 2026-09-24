// Bundle entry: the package's one loader row is the Git Bash tool itself, so the
// root export is the tool plugin. Kept as a re-export rather than a second plugin so
// there is exactly one place that owns the tool definition.
//
// The default export is the apply function: the loader reads a plugin's metadata off
// the value it applies, so `inject` travels as a property of that function. The
// named exports beside it are a convenience, not the contract: the loader reads the
// metadata off the value it uses, so a module whose `inject` exists only as a named
// export mounts with an undeclared context and dies at the first `ctx.systemPrompt`
// ("cannot get property \"systemPrompt\" without inject"), taking the whole boot with
// it. That is why `tool/index.js` assigns `apply.inject = inject` before exporting.
// A module that offers neither a default apply nor a default plugin object is not a
// dsh plugin at all, which is what the release check in publish.yml verifies.
export { Config, apply, inject, name } from './tool/index.js'
export { default } from './tool/index.js'
