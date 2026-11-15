# Contributing

## Branches

Pull requests target `dev`. Maintainers fast-forward `main` before a release. Merging, tagging, and publishing are maintainer actions. CI runs on pull requests.

## Pull request descriptions

A description states the change, the work completed, and the checks actually run, in a Simplified Chinese section and a matching English section. Deferred work belongs in an issue.

## Documentation

`README.md` and `README.en.md` change together. `docs/CHANGELOG.md` and `docs/CHANGELOG.en.md` change together. `npm run docs:check` compares the pairs declared in `scripts/check-docs.mjs`. Tracked files contain no personal paths, credentials, private host details, or one-off logs.

## Verification

Run these checks before opening a pull request:

```sh
npm test
npm run test:e2e
npm run docs:check
for f in lib/index.js lib/tool/index.js lib/tool/exec.js lib/tool/kit.js; do node --check "$f"; done
npm pack --dry-run
```

`npm run test:e2e` spawns Git Bash and requires an unsandboxed shell.

## Version history

Release notes are generated from the section for the tagged version in `docs/CHANGELOG.md`. `docs/RELEASING.md` records the maintainer release steps.

## Security reports

Security findings follow [SECURITY.md](SECURITY.md).
