// Bundle entry: the package's one loader row is the Git Bash tool itself, so the
// root export is the tool plugin. Kept as a re-export rather than a second plugin so
// there is exactly one place that owns the tool definition.
//
// The default export is the apply function, the shape dsh-ballast and dsh-treekeeper
// ship; `inject` and `name` travel as named exports beside it. A module that offers
// neither a default apply nor a default plugin object is not a dsh plugin, which is
// what the release check in publish.yml verifies.
export { Config, apply, inject, name } from './tool/index.js'
export { default } from './tool/index.js'
