// Разбор журнала ручных сопоставлений (выгрузка scripts/supply-match-log.sh): что человек сопоставил в окне «Счета и КП тендера» и что
// предлагает текущий алгоритм (src/utils/supplyDocMatch.js). Только чтение файла выгрузки; база и файлы не меняются.
//
//   node scripts/supply-match-review.mjs <выгрузка.json> [--known <корпус.json>] [--save <корпус.json>] [--all]
//
// По каждому решению человека:
//   САМ        — алгоритм ставит ту же позицию первой и сам (похожесть от AUTO_MIN);
//   СЛАБО      — та же позиция первой, но сама не выбирается (ниже AUTO_MIN);
//   НЕ ПЕРВОЙ  — позиция в списке выбора, но не первой (место и похожесть);
//   НЕ НАШЁЛ   — позиции нет в списке совсем;
//   ОТВЕРГНУТО — «нет в счетах»: алгоритм всё равно ставит эту позицию первой (без отказа человека).
// --known — корпус прошлых разборов: такие решения помечаются «было», новые — первыми. --save — дописать новые решения в корпус
// (наименования и ед. изм. без цен: вне репозитория, ~/osp-match-log/corpus.json). --all — показывать и «САМ».
// Решения, которые стоит закрепить тестом, переносятся в tests/supply/fixtures/match-corpus.json (порядок — docs/claude-reference/
// supply-pricing.md, «Журнал ручных сопоставлений»).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// SUPPLY_UTILS — другая копия src/utils (алгоритм «до правки»): так сравнивают, что правка дала на всём журнале.
const UTILS = process.env.SUPPLY_UTILS ? path.resolve(process.env.SUPPLY_UTILS) : path.join(ROOT, 'src/utils')
const { readOffer } = await import(path.join(UTILS, 'supplyOffers.js'))
const { AUTO_MIN, MATCH_CANDIDATES, itemCandidates, matchIndex, mergeSamePositions, positionGroups } = await import(path.join(UTILS, 'supplyDocMatch.js'))

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const file = args.find((a, i) => !a.startsWith('--') && !['--known', '--save'].includes(args[i - 1]))
if (!file) {
  console.error('Укажите выгрузку: node scripts/supply-match-review.mjs ~/osp-match-log/export-ГГГГ-ММ-ДД.json')
  process.exit(2)
}
const data = JSON.parse(fs.readFileSync(file, 'utf8'))
const knownFile = opt('--known')
const saveFile = opt('--save')
const showAll = args.includes('--all')
const known = new Map()
for (const f of [knownFile, saveFile]) {
  if (f && fs.existsSync(f)) for (const d of JSON.parse(fs.readFileSync(f, 'utf8')).decisions || []) known.set(decisionKey(d), d)
}
function decisionKey(d) {
  return `${d.kind}|${d.line}|${d.lineUnit || ''}|${d.position}|${d.positionUnit || ''}`
}

const short = (s, n = 70) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
const decisions = []
for (const tender of data.tenders || []) {
  const groups = mergeSamePositions(positionGroups((tender.sources || []).map((s) => ({ name: s.name, positions: s.positions || [] }))))
  const index = matchIndex(groups)
  const byKey = new Map()
  for (const g of groups) for (const k of g.ks || [g.k]) byKey.set(k, g)
  for (const doc of tender.docs || []) {
    const offer = readOffer(doc.notes)
    if (!offer?.lines.length) continue
    for (const line of offer.lines) {
      const picked = [line.k, ...(line.also || [])].filter(Boolean)
      if (!picked.length && !line.no?.length) continue
      // Как строку видит алгоритм без выбора человека.
      const free = { ...line, k: null, also: [], no: [] }
      const list = itemCandidates(free, groups, index, MATCH_CANDIDATES, { packs: true })
      const top = list[0] || null
      const base = {
        tender: tender.number, doc: doc.file_name, scan: !!offer.ocr, line: line.name, lineUnit: line.unit || null,
        top: top ? { name: top.group.name, score: top.score } : null,
      }
      // Строку выбрали сразу для нескольких позиций (одна и та же позиция разных ВОР): выше выбранной могут стоять только выбранные.
      const pickedGroups = new Set(picked.map((k) => byKey.get(k)).filter(Boolean))
      for (const k of picked) {
        const g = byKey.get(k)
        if (!g) continue // позиции уже нет в ВОР (новая версия)
        const at = list.findIndex((c) => c.group === g)
        const c = at >= 0 ? list[at] : null
        const first = at >= 0 && list.slice(0, at).every((x) => pickedGroups.has(x.group))
        const verdict = first ? (c.exact || c.score >= AUTO_MIN ? 'САМ' : 'СЛАБО') : at >= 0 ? 'НЕ ПЕРВОЙ' : 'НЕ НАШЁЛ'
        decisions.push({ ...base, kind: 'same', position: g.name, positionUnit: g.unit || (g.units || []).join(', ') || null, verdict, rank: at + 1, score: c?.score ?? null })
      }
      for (const k of line.no || []) {
        const g = byKey.get(k)
        if (!g) continue
        const verdict = top?.group === g ? 'ОТВЕРГНУТО' : 'ОК'
        decisions.push({ ...base, kind: 'not', position: g.name, positionUnit: g.unit || null, verdict, rank: list.findIndex((c) => c.group === g) + 1, score: list.find((c) => c.group === g)?.score ?? null })
      }
    }
  }
}

const order = { 'НЕ НАШЁЛ': 0, 'ОТВЕРГНУТО': 1, 'НЕ ПЕРВОЙ': 2, 'СЛАБО': 3, 'САМ': 4, 'ОК': 5 }
const fresh = decisions.filter((d) => !known.has(decisionKey(d)))
const shown = (showAll ? decisions : decisions.filter((d) => d.verdict !== 'САМ' && d.verdict !== 'ОК'))
  .sort((a, b) => Number(known.has(decisionKey(a))) - Number(known.has(decisionKey(b))) || order[a.verdict] - order[b.verdict] || (a.tender ?? 0) - (b.tender ?? 0))
for (const d of shown) {
  const tag = known.has(decisionKey(d)) ? 'было' : 'новое'
  const score = d.score != null ? ` ${d.score}` : ''
  const rel = d.kind === 'same' ? '=' : '≠'
  console.log(`${d.verdict.padEnd(10)} [${tag}] № ${d.tender} · ${short(d.doc, 40)}${d.scan ? ' (скан)' : ''}`)
  console.log(`    строка:  ${short(d.line, 110)} [${d.lineUnit || '—'}]`)
  console.log(`    ${rel} ВОР:   ${short(d.position, 110)} [${d.positionUnit || '—'}]${d.rank > 0 ? ` — место ${d.rank},${score}` : ''}`)
  if (d.top && d.top.name !== d.position) console.log(`    алгоритм: ${short(d.top.name, 105)} [${d.top.score}]`)
}
const count = (v) => decisions.filter((d) => d.verdict === v).length
console.log(`\nРешений: ${decisions.length} (новых: ${fresh.length}). Сам — ${count('САМ')}, первой, но не сам — ${count('СЛАБО')}, не первой — ${count('НЕ ПЕРВОЙ')}, `
  + `не нашёл — ${count('НЕ НАШЁЛ')}; «нет в счетах»: учтено — ${count('ОК')}, предлагается снова — ${count('ОТВЕРГНУТО')}.`)

if (saveFile) {
  const prev = fs.existsSync(saveFile) ? JSON.parse(fs.readFileSync(saveFile, 'utf8')).decisions || [] : []
  const have = new Set(prev.map(decisionKey))
  const add = decisions.filter((d) => !have.has(decisionKey(d))).map((d) => ({
    kind: d.kind, line: d.line, lineUnit: d.lineUnit, position: d.position, positionUnit: d.positionUnit, tender: d.tender, scan: d.scan, seen: data.at || null,
  }))
  fs.mkdirSync(path.dirname(saveFile), { recursive: true })
  fs.writeFileSync(saveFile, `${JSON.stringify({ decisions: [...prev, ...add] }, null, 1)}\n`)
  console.log(`Корпус: ${saveFile} (+${add.length})`)
}
