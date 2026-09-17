// Bundle entry: the package's one loader row is the Git Bash tool itself, so the
// root export is the tool plugin. Kept as a re-export rather than a second
// plugin so there is exactly one place that owns the tool definition.
export { Config, apply, inject, name } from './tool/index.js'
