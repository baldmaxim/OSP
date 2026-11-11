#!/usr/bin/env node
// Отчёт администратору ОСП: организации-подрядчики СУ-10 и подсказки «какой это контрагент» (temp/osp-org-mapping.md, раздел 2).
// Миграций и связей НЕ создаёт: связь ставит администратор во вкладке «Организации СУ-10» (решение пользователя 11.11.2026 —
// автоматическая связь только строгая, а в выгрузке auth нет ИНН реестра). Правила подсказок — server/osp-api/src/lib/orgMatch.js.
//
//   node migration/org-links/build.mjs --orgs temp/su10-orgs-<дата>.csv \
//     --snapshot migration/target/reports/org-links-<дата>/counterparties.json --out migration/target/reports/org-links-<дата>
//
// Пишет в --out (каталог вне git, права 0700, файлы 0600): report.md, report.csv (защищён от формул Excel), auth-summary.txt.
// В выводе команды — только числа: в выгрузке есть ФИО индивидуальных предпринимателей.
import fs from 'node:fs'
import process from 'node:process'
import path from 'node:path'
import { parseOrgsCsv, planReport, csvCell, MATCH_REASONS, MATCH_FLAGS, cleanInn } from '../../server/osp-api/src/lib/orgMatch.js'

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]
    if (!k?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`аргумент: ${k ?? ''}`)
    out[k.slice(2)] = argv[i + 1]
  }
  for (const k of ['orgs', 'snapshot', 'out']) if (!out[k]) throw new Error(`нужен --${k}`)
  return out
}

const md = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
const cpLabel = (c) => `№ ${c.number ?? '—'} ${c.name}${c.inn ? ` (ИНН ${c.inn})` : ''}${c.status === 'blacklist' ? ' [ЧС]' : c.status === 'limited' ? ' [малые суммы]' : ''}`
const why = (cand) => [...cand.reasons.map((r) => MATCH_REASONS[r]), ...cand.flags.map((f) => `⚠ ${MATCH_FLAGS[f]}`)].join('; ')

export function renderReport({ rows, stats, problems, takenAt, csvName }) {
  const lines = [
    '# Организации-подрядчики СУ-10 и подсказки «какой это контрагент ОСП»',
    '',
    `Выгрузка auth: ${csvName}. Снимок контрагентов ОСП: ${takenAt}. Отчёт для администратора ОСП, в git не кладётся.`,
    '',
    '**Связь ставит администратор** во вкладке «Администрирование» → «Организации СУ-10» → «Сопоставить…» (там те же подсказки).',
    'Автоматической связи нет: ИНН из реестра СУ-10 в выгрузке не заполнен, а подсказки BillHub, название и домен — только',
    'подсказки. Ошибка связи открыла бы подрядчику чужую историю контрагента: проверяйте ИНН в карточке контрагента.',
    '',
    `- организаций в выгрузке: ${stats.orgs} (свои: ${stats.own}, подрядчики: ${stats.contractors})`,
    `- с ИНН реестра СУ-10: ${stats.registryInn}; с подсказкой ИНН из BillHub: ${stats.innHints}`,
    `- «ИНН совпал» (строгий кандидат): ${stats.confident}`,
    `- с сильной подсказкой (ИНН из BillHub, ИНН в названии, то же название): ${stats.withStrong}`,
    `- только похожее название или домен: ${stats.weakOnly}`,
    `- без кандидатов: ${stats.none} — вероятно, контрагента в ОСП нет: «Создать контрагента» во вкладке`,
    `- контрагентов, на которых претендуют две организации и больше: ${stats.claimed}`,
    ...(problems.length ? [`- строк выгрузки с ошибками (пропущены): ${problems.map((p) => `строка ${p.line} — ${p.problem}`).join('; ')}`] : []),
    '',
  ]
  const group = (title, filter) => {
    const list = rows.filter(filter)
    if (!list.length) return
    lines.push(`## ${title} (${list.length})`, '')
    for (const r of list) {
      const o = r.org
      const hints = (o.innHints || []).map((h) => `${h.inn}${h.name ? ` «${h.name}»` : ''}`).join(', ')
      lines.push(`### ${md(o.name)}`, '')
      lines.push(`- id: \`${o.su10OrgId}\`${cleanInn(o.inn) ? `; ИНН СУ-10: ${o.inn}` : ''}${hints ? `; BillHub: ${md(hints)}` : ''}${o.emailDomains.length ? `; домены: ${md(o.emailDomains.join(', '))}` : ''}`)
      if (!r.candidates.length) lines.push('- кандидатов нет')
      for (const c of r.candidates) {
        const mark = r.confident?.counterparty.id === c.counterparty.id ? '**ИНН совпал** — ' : ''
        lines.push(`- ${mark}${md(cpLabel(c.counterparty))} — ${md(why(c))}`)
      }
      lines.push('')
    }
  }
  const strong = (r) => r.candidates.some((c) => c.reasons.some((x) => ['inn', 'inn_soft', 'inn_hint', 'inn_in_name', 'name'].includes(x)))
  group('ИНН совпал', (r) => r.confident)
  group('Сильная подсказка', (r) => !r.confident && strong(r))
  group('Похожее название или домен', (r) => !r.confident && !strong(r) && r.candidates.length)
  group('Кандидатов нет', (r) => !r.candidates.length)
  return lines.join('\n')
}

export function renderCsv(rows) {
  const out = [['su10_org_id', 'организация', 'ИНН СУ-10', 'ИНН BillHub', 'кандидат №', 'кандидат', 'ИНН кандидата', 'статус', 'ИНН совпал', 'почему'].map(csvCell).join(',')]
  for (const r of rows) {
    const o = r.org
    const base = [o.su10OrgId, o.name, cleanInn(o.inn) || '', (o.innHints || []).map((h) => h.inn).join(' ')]
    if (!r.candidates.length) out.push([...base, '', '', '', '', '', 'кандидатов нет'].map(csvCell).join(','))
    for (const c of r.candidates) {
      out.push([...base, c.counterparty.number ?? '', c.counterparty.name, c.counterparty.inn || '', c.counterparty.status,
        r.confident?.counterparty.id === c.counterparty.id ? 'да' : '', why(c)].map(csvCell).join(','))
    }
  }
  return `\uFEFF${out.join('\r\n')}\r\n`
}

export function renderAuthSummary({ rows, stats, takenAt }) {
  return [
    `Тендер ОСП: сопоставление организаций СУ-10 с контрагентами ОСП (снимок ${takenAt}).`,
    `Организаций-подрядчиков: ${stats.contractors}. Связей, поставленных автоматически: 0 — в выгрузке нет ИНН реестра,`,
    'связь ставит администратор ОСП вручную во вкладке «Организации СУ-10». Итог после связывания: identity links-report на сервере.',
    `Подсказки есть у ${stats.contractors - stats.none} из ${stats.contractors}, без подсказок — ${stats.none}.`,
    '',
    'Без пары на момент снимка (все):',
    ...rows.map((r) => `${r.org.su10OrgId}\t${r.org.name}`),
    '',
  ].join('\n')
}

async function main() {
  const a = args(process.argv.slice(2))
  const { orgs, problems } = parseOrgsCsv(fs.readFileSync(a.orgs, 'utf8'))
  const snap = JSON.parse(fs.readFileSync(a.snapshot, 'utf8'))
  if (!Array.isArray(snap.counterparties)) throw new Error('снимок: нет counterparties')
  const { rows, stats } = planReport(orgs, snap.counterparties)
  fs.mkdirSync(a.out, { recursive: true, mode: 0o700 })
  fs.chmodSync(a.out, 0o700)
  const write = (name, text) => {
    const file = path.join(a.out, name)
    fs.writeFileSync(file, text, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
  }
  write('report.md', renderReport({ rows, stats, problems, takenAt: snap.taken_at, csvName: path.basename(a.orgs) }))
  write('report.csv', renderCsv(rows))
  write('auth-summary.txt', renderAuthSummary({ rows, stats, takenAt: snap.taken_at }))
  // Только числа — в выгрузке ФИО индивидуальных предпринимателей.
  console.log(JSON.stringify({ ...stats, problems: problems.length, counterparties: snap.counterparties.length }))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(`build: ${err.message}`); process.exit(1) })
}
