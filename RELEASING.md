# Releasing

Releases are tag-driven. Develop and verify on `dev`, merge the release commit into `main`, tag it there. Only release-ready changes belong on `main`.

`publish.yml` publishes: a `vX.Y.Z` tag triggers it, it verifies the tag, reruns every check, publishes to npm through Trusted Publishing (OIDC), and creates the GitHub release from `CHANGELOG.md`. Nothing is published by hand.

## How the workflow splits its credentials

Three jobs. `GITHUB_TOKEN` is exported into every step of a job, so the split is what keeps a repository-write token away from the code under test — the tested code here spawns a real Git Bash. Anything that executes repository code belongs in `checks`; do not move a test into another job.

| Job | Permissions | Runs |
| --- | --- | --- |
| `checks` | `contents: read` | `npm ci --ignore-scripts`, then every check below on a Windows runner. |
| `npm` | `contents: read`, `id-token: write` | `npm publish --provenance`. Installs nothing: this package declares no `prepare` or `prepack` script, so packing needs no dependency tree. Add one and this job has to install — and think about what runs there while holding a publish credential. |
| `release` | `contents: write` | `scripts/release-notes.mjs` over `CHANGELOG.md`, then `gh release`. No install, no tests. |

`release` waits for `checks` but not for a successful npm publish, so a registry hiccup still leaves the version its notes, and an out-of-band first publish gets its release too.

## Checklist

1. On `dev`, choose `X.Y.Z` and update:
   - `package.json#version`
   - the first section of both changelogs: `## X.Y.Z - YYYY-MM-DD`, replacing `## Unreleased`

   Keep that heading format: `publish.yml` extracts the release notes from it.
2. Run every check the workflow will run:

   ```sh
   npm test          # pure units; no process is spawned
   npm run test:e2e  # spawns Git Bash; needs an unsandboxed shell
   npm run docs:check
   for f in lib/index.js lib/tool/index.js lib/tool/exec.js; do node --check "$f"; done
   npm pack --dry-run
   ```

   Run them from a shell that may spawn processes. `test:e2e` starts Git Bash and writes spill files under the OS temp directory, which is exactly what the dsh file sandbox refuses, so a sandboxed tool call reports a failure that says nothing about the release. A machine that cannot run `test:e2e` is not a release machine; do not publish with that half skipped or excused.
3. Commit and push `dev`, then merge it into `main` once CI passes:

   ```sh
   git switch main
   git merge dev -m "merge: dev -> main"
   git push origin main
   ```

4. Tag the release commit on `main` and push the tag:

   ```sh
   git switch main
   git pull --ff-only
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The workflow refuses a tag whose version does not match `package.json`, and one that does not point at a commit reachable from `main`. Tag after the merge, from `main`: a commit tagged on `dev` is not a release, and after a squash merge or a rebase the commit you tagged is not the commit that landed, so the ancestry check fails. Sync `main` and tag the commit that is actually there.

## One-time setup, already done

npm's Trusted Publishing relationship is configured on npmjs.com for this package, bound to this repository and to `.github/workflows/publish.yml`. Renaming the package, the repository owner, or that workflow file breaks the binding, and only a `npm publish` from a logged-in account can re-establish it. Every published version so far (0.1.0 through 0.1.4) went out through the workflow.

## After the tag

Published npm versions are immutable. If one is wrong, deprecate it and release a new patch; never move or delete a tag to make the workflow retry.

```sh
npm deprecate "dsh-unsandboxed-winbash@X.Y.Z" <reason>
```
