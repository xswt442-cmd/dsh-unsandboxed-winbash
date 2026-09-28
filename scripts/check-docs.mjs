#!/usr/bin/env node
// Bilingual structure check for the documentation pairs this repository ships.
// The pairs, their paths and their comparison shapes are declared in the `pairs`
// constant below, so a document moving directories is an edit there.
//
// What it verifies, taking no file arguments:
//   * both READMEs share the same heading-level sequence and code-fence
//     languages; content inside fences is exempt, since that is where
//     language-specific examples live;
//   * both CHANGELOGs expose the same releases, the `Unreleased` section
//     included since that is where the newest edits land, with version, date,
//     per-section item counts, and section titles normalized through a bilingual
//     category map (新增/Added, 修复/Fixed, ...);
//   * with `--base <revision>`, both files of each declared pair changed together
//     since that revision: a one-sided edit is a missing translation. An all-zero
//     revision is the null OID, which is what `github.event.before` carries for a
//     branch that was just created or force-pushed; there is no previous revision
//     to diff against, so that one requirement is skipped with a note instead of
//     dying inside `git diff`.
//
// This repository keeps its own copy of the check rather than depending on one.
// It embeds no shared source fragment, so a documentation lint would be the only
// reason to install something from outside — and that reason is not worth the
// coupling: `npm run docs:check` then needs a successful install, on a machine
// and in a CI job where the check itself is the thing that must always run.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

function markdownShape(file) {
  let fenced = false
  const headings = []
  const fences = []

  for (const line of read(file).split('\n')) {
    const fence = line.match(/^\s*```\s*(\S*)/)
    if (fence) {
      if (!fenced) fences.push(fence[1])
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const heading = line.match(/^(#{1,3})\s+/)
    if (heading) headings.push(heading[1].length)
  }

  if (fenced) throw new Error(`${file}: unclosed code fence`)
  return { headings, fences }
}

function changelogShape(file) {
  const releases = []
  let release
  let section

  // A `## ...` heading opens a release and clears the current section, so bullets
  // that follow it before any `###` still count — into an anonymous leading
  // section — instead of being silently dropped.
  const openRelease = (version, date) => {
    release = { version, date, sections: [] }
    releases.push(release)
    section = undefined
  }

  for (const line of read(file).split('\n')) {
    const version = line.match(/^##\s+(\d+\.\d+\.\d+)(?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/)
    if (version) {
      openRelease(version[1], version[2] ?? '')
      continue
    }
    // `Unreleased` is the version-less top release and usually the most-edited
    // section, so it is compared with the same shape as a numbered one. Both
    // languages keep the literal heading, so the labels match directly.
    if (/^##\s+Unreleased\s*$/i.test(line)) {
      openRelease('Unreleased', '')
      continue
    }
    if (!release) continue

    const heading = line.match(/^###\s+(.+?)\s*$/)
    if (heading) {
      section = { title: heading[1], items: 0 }
      release.sections.push(section)
      continue
    }
    if (/^\s*-\s+/.test(line)) {
      if (!section) {
        section = { title: '', items: 0 }
        release.sections.push(section)
      }
      section.items += 1
    }
  }

  return releases
}

const category = new Map([
  ['新增', 'added'], ['Added', 'added'],
  ['修复', 'fixed'], ['Fixed', 'fixed'],
  ['变更', 'changed'], ['Changed', 'changed'],
  ['移除', 'removed'], ['Removed', 'removed'],
  ['安全', 'security'], ['Security', 'security'],
  ['性能', 'performance'], ['Performance', 'performance'],
  ['兼容性', 'compatibility'], ['Compatibility', 'compatibility'],
  ['维护', 'maintenance'], ['Maintenance', 'maintenance'],
])

function assertEqual(left, right, message) {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${message}\nleft:  ${JSON.stringify(left)}\nright: ${JSON.stringify(right)}`)
  }
}

// The pairs this repository ships, with the shape each is compared by. Everything
// below reads this list and nothing else, so a document can move or a new pair can
// be added by editing these two entries.
const normalizeLog = (file) => changelogShape(file).map((release) => ({
  version: release.version,
  date: release.date,
  sections: release.sections.map(({ title, items }) => ({
    title: category.get(title) ?? title.toLowerCase(),
    items,
  })),
}))

const pairs = [
  { name: 'README', zh: 'README.md', en: 'README.en.md', shape: markdownShape },
  { name: 'CHANGELOG', zh: 'docs/CHANGELOG.md', en: 'docs/CHANGELOG.en.md', shape: normalizeLog },
]

for (const pair of pairs) {
  assertEqual(pair.shape(pair.zh), pair.shape(pair.en), `${pair.name} structure differs between languages`)
}

const baseIndex = process.argv.indexOf('--base')
if (baseIndex !== -1) {
  const base = process.argv[baseIndex + 1]
  if (!base) throw new Error('--base requires a Git revision')

  // The null OID, in either hash length. A workflow that passes
  // `github.event.before` here gets it whenever a branch is created or
  // force-pushed, and `git diff 000... HEAD` is not a comparison with no base —
  // it is an error. So the honest reading is the one the push event states: there
  // is nothing before this push, and the pair test cannot run.
  if (/^0+$/.test(base)) {
    console.log(`note: --base ${base} is the null OID (new branch or force-push) — pair-change check skipped`)
  } else {
    const changed = new Set(execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean))

    for (const pair of pairs) {
      if (changed.has(pair.zh) !== changed.has(pair.en)) {
        throw new Error(`${pair.zh} and ${pair.en} must change together`)
      }
    }
  }
}

console.log('bilingual docs are structurally aligned')
