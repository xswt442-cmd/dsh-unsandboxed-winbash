// Bundle entry: the package's one loader row is the Git Bash tool itself, so the
// root export is the tool plugin. It re-exports rather than defining a second
// plugin, so one module owns the tool definition.
//
// The default export is the apply function. The loader reads a plugin's metadata
// off the value it applies, so `inject` travels as a property of that function;
// the named exports beside it are a convenience, not the contract. That is why
// `tool/index.js` assigns `apply.inject = inject` before exporting. A module with
// neither a default apply nor a default plugin object is not a dsh plugin, which is
// what the release check in publish.yml verifies.
export { Config, apply, inject, name } from './tool/index.js'
export { default } from './tool/index.js'
