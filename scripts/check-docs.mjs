// Bilingual docs check: README.md and README.zh.md must have the same heading
// shape. Deliberately narrow — this repository has one pair of files and no
// changelog, so a full copy of the sibling plugins' checker would be maintenance
// without a matching problem.
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

function shape(file) {
  const headings = []
  let fenced = false
  for (const line of read(file).split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const heading = line.match(/^(#{1,3})\s+/)
    if (heading) headings.push(heading[1].length)
  }
  if (fenced) throw new Error(file + ': unclosed code fence')
  return headings
}

const en = shape('README.md')
const zh = shape('README.zh.md')
if (JSON.stringify(en) !== JSON.stringify(zh)) {
  console.error('README.md and README.zh.md heading structure differs')
  console.error('en:', en.join(','))
  console.error('zh:', zh.join(','))
  process.exit(1)
}
console.log('bilingual docs are structurally aligned')
