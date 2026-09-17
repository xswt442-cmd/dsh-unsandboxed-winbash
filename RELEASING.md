# Releasing

Releases are tag-driven. Develop and verify on `dev`, then merge the release commit into `main`. Only release-ready changes belong on `main`.

## Checklist

1. On `dev`, choose `X.Y.Z` and update:
   - `package.json#version`
   - the first section of both changelogs: `## X.Y.Z - YYYY-MM-DD`
2. Run:

   ```sh
   npm test          # pure units; no process is spawned
   npm run test:e2e  # spawns Git Bash; needs an unsandboxed shell
   npm run docs:check
   node --check lib/index.js
   node --check lib/tool/exec.js
   npm pack --dry-run
   ```

3. Commit and push `dev`, then merge it into `main` once CI passes:

   ```sh
   git switch main
   git merge dev -m "merge: dev -> main"
   git push origin main
   ```

4. From the release commit on `main`, create and push the tag:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

`publish.yml` checks that the tag matches `package.json`, reruns the checks, publishes with npm provenance, and creates the GitHub release from `CHANGELOG.md`. It is idempotent: a version already on npm is skipped and an existing release has its notes refreshed.

## First release

The workflow authenticates through npm Trusted Publishing (OIDC), which is configured on npmjs.com for this exact repository and workflow file. That binding cannot exist before the package name does, so the first version is published once by hand with a logged-in account:

```sh
npm publish --access public
```

After that the tag-driven path owns every later version. Published npm versions are immutable: deprecate a bad version and publish a new patch instead of moving a tag.
