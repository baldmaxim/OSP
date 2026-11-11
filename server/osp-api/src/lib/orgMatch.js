// Подсказки «организация СУ-10 → контрагент ОСП» — для отчёта разового сопоставления (migration/org-links/build.mjs) и для
// окна «Сопоставить…» во вкладке «Организации СУ-10» (src/lib/auth/orgs.js). Чистые функции, без базы.
//
// Подсказка — не решение: связь ставит только администратор (решение пользователя 11.11.2026 по рецензии плана — ошибка
// связи открыла бы чужую историю контрагента). «Уверенный» кандидат — только когда всё сразу:
//   • организация — подрядчик;
//   • ИНН из реестра СУ-10 (не подсказка BillHub): 10 или 12 цифр, контрольная сумма сходится;
//   • ровно один неудалённый контрагент, у которого ячейка ИНН после trim совпадает с ним полностью, и мягкий поиск
//     (КПП через «/», потерянный ведущий ноль, два ИНН в ячейке — как SAME_INN в src/lib/auth/signup.js) других не нашёл;
//   • контрагент не в чёрном списке и на него не претендует другая организация.
// Остальные совпадения (подсказка BillHub, ИНН в названии, название, домен почты) — кандидаты с причинами.
import { isValidInn, isPublicMailDomain } from '../shared/contractorSignupRules.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MATCH_REASONS = {
  inn: 'ИНН реестра СУ-10 совпал',
  inn_soft: 'ИНН реестра СУ-10 похож (КПП, ведущий ноль, два ИНН в ячейке)',
  inn_hint: 'ИНН из подсказки BillHub',
  inn_in_name: 'ИНН в названии организации',
  name: 'Название совпало',
  name_similar: 'Название похоже',
  domain: 'Почтовый домен сотрудников',
}
export const MATCH_FLAGS = {
  blacklist: 'Контрагент в чёрном списке',
  hint_name: 'Название в BillHub другое — проверьте',
  checksum: 'ИНН не прошёл контрольную сумму',
  duplicate: 'Есть другие контрагенты с этим признаком',
  main_record: 'Основная запись среди дублей',
  claimed: 'На контрагента претендует и другая организация',
}
const WEIGHT = { inn: 100, inn_soft: 70, inn_hint: 60, inn_in_name: 50, name: 40, name_similar: 15, domain: 10 }
const STRONG = new Set(['inn', 'inn_soft', 'inn_hint', 'inn_in_name', 'name'])

// ── CSV ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Выгрузка auth предваряет апострофом значения, начинающиеся с = + - @ или табуляции (защита от формул в Excel).
// Для сравнения апостроф снимается; наружу такое значение так не выводится — csvCell снова его защитит.
export const unguard = (v) => {
  const s = String(v ?? '')
  return /^'[=+\-@\t]/.test(s) ? s.slice(1) : s
}

// Ячейка CSV для отчёта: значение с = + - @ \t \r в начале — с апострофом; кавычки — по правилам CSV.
export function csvCell(v) {
  let s = String(v ?? '')
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n;]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s
}

// RFC 4180: кавычки, удвоенные кавычки, переводы строк внутри кавычек; BOM в начале. → string[][]
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '').trim() !== '')
}

const ORG_COLUMNS = ['su10_org_id', 'kind', 'name', 'inn', 'users', 'email_domains', 'inn_hint', 'inn_hint_names']

// Выгрузка организаций auth (su10-orgs-<дата>.csv) → { orgs, problems }. Строки с негодным id или видом — в problems (номер строки).
export function parseOrgsCsv(text) {
  const rows = parseCsv(text)
  if (!rows.length) return { orgs: [], problems: [{ line: 1, problem: 'файл пуст' }] }
  const head = rows[0].map((h) => h.trim())
  const missing = ORG_COLUMNS.filter((c) => !head.includes(c))
  if (missing.length) return { orgs: [], problems: [{ line: 1, problem: `нет колонок: ${missing.join(', ')}` }] }
  const at = Object.fromEntries(head.map((h, i) => [h, i]))
  const orgs = []
  const problems = []
  const seen = new Set()
  rows.slice(1).forEach((r, k) => {
    const line = k + 2
    const get = (c) => unguard((r[at[c]] ?? '').trim())
    const id = get('su10_org_id').toLowerCase()
    const kind = get('kind')
    if (!UUID.test(id)) { problems.push({ line, problem: 'su10_org_id не UUID' }); return }
    if (kind !== 'own' && kind !== 'contractor') { problems.push({ line, problem: 'kind не own/contractor' }); return }
    if (seen.has(id)) { problems.push({ line, problem: 'su10_org_id повторяется' }); return }
    seen.add(id)
    const hintInns = get('inn_hint').split('|').map((x) => x.split(':')[0].trim()).filter(Boolean)
    const hintNames = get('inn_hint_names').split('|').map((x) => x.trim())
    orgs.push({
      su10OrgId: id,
      kind,
      name: get('name'),
      inn: get('inn'),
      users: Number(get('users')) || 0,
      emailDomains: get('email_domains').split('|').map((x) => x.split(':')[0].trim().toLowerCase()).filter(Boolean),
      innHints: hintInns.map((inn, i) => ({ inn, name: hintNames.length === hintInns.length ? hintNames[i] : (hintNames.length === 1 ? hintNames[0] : '') })),
    })
  })
  return { orgs, problems }
}

// ── ИНН ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const digits = (s) => String(s ?? '').replace(/\D+/g, '')
const noLeadingZeros = (s) => String(s).replace(/^0+/, '')
// ИНН вида 10/12 цифр (только цифры, без знаков вокруг) или null.
export function cleanInn(value) {
  const s = unguard(String(value ?? '').trim())
  return /^(\d{10}|\d{12})$/.test(s) ? s : null
}
// Ячейка ИНН контрагента совпадает полностью (после trim).
export const exactInn = (cell, inn) => String(cell ?? '').trim() === inn
// Мягкое совпадение — как SAME_INN (signup.js): все цифры ячейки, либо любой цифровой отрезок без ведущих нулей.
export function softInn(cell, inn) {
  const c = String(cell ?? '')
  if (!inn || !c) return false
  if (digits(c) === inn) return true
  const want = noLeadingZeros(inn)
  return (c.match(/\d+/g) || []).some((run) => noLeadingZeros(run) === want)
}
const innKeys = (cell) => [...new Set([noLeadingZeros(digits(cell)), ...(String(cell ?? '').match(/\d+/g) || []).map(noLeadingZeros)])]
  .filter((k) => k.length >= 8)

// ── Название ────────────────────────────────────────────────────────────────────────────────────────────────────
// Как companyNameKey (contractorSignupRules.js): регистр, латиница-двойник, ё, формы организации где угодно, кавычки; плюс НКО.
// Слова — для сравнения без учёта порядка («СТРОЙМИР ООО ИК» = «ООО ИК «Строймир»»). ИНН в названии — отдельно.
const LOOKALIKE = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' }
const FORMS = new Set(['ооо', 'оао', 'зао', 'пао', 'ао', 'нао', 'ано', 'гуп', 'муп', 'фгуп', 'гбу', 'ип', 'сз', 'тоо', 'нко'])
const FORM_PHRASES = /общество с ограниченной ответственностью|публичное акционерное общество|закрытое акционерное общество|открытое акционерное общество|непубличное акционерное общество|акционерное общество|индивидуальный предприниматель|некоммерческая организация|самозанят(?:ый|ая)/gu
export function nameWords(value) {
  const s = String(value ?? '').normalize('NFC').toLowerCase()
    .replace(/[abcehkmoptxy]/g, (ch) => LOOKALIKE[ch]).replace(/ё/g, 'е')
    .replace(/∕/g, '/').replace(FORM_PHRASES, ' ')
  return s.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !FORMS.has(w) && !(/^\d{10}$|^\d{12}$/.test(w) && isValidInn(w)))
}
export const nameKey = (value) => nameWords(value).join('')
export const nameSortedKey = (value) => [...nameWords(value)].sort().join(' ')
// ИНН в названии («ЭКС ООО (ИНН)»): только с верной контрольной суммой.
export const innsInName = (value) => (String(value ?? '').match(/\d{10,12}/g) || []).filter((x) => cleanInn(x) && isValidInn(x))
// Названия «о том же»: общее слово от 3 букв или одно и то же без пробелов. Для проверки подсказки BillHub, не для связи.
export function namesAgree(a, b) {
  const ka = nameKey(a)
  const kb = nameKey(b)
  if (ka && ka === kb) return true
  const wb = new Set(nameWords(b).filter((w) => w.length >= 3))
  return nameWords(a).some((w) => w.length >= 3 && wb.has(w))
}

// ── Индекс контрагентов ─────────────────────────────────────────────────────────────────────────────────────────
// counterparties: [{ id, number, name, inn, status, contracts, tenders, relations, domains: [] }] — неудалённые.
export function buildIndex(counterparties) {
  const byId = new Map()
  const byInn = new Map()
  const byKey = new Map()
  const bySorted = new Map()
  const byWord = new Map()
  const byDomain = new Map()
  const add = (map, key, cp) => {
    if (!key) return
    let set = map.get(key)
    if (!set) map.set(key, (set = new Set()))
    set.add(cp)
  }
  for (const cp of counterparties) {
    byId.set(cp.id, cp)
    for (const k of innKeys(cp.inn)) add(byInn, k, cp)
    add(byKey, nameKey(cp.name), cp)
    add(bySorted, nameSortedKey(cp.name), cp)
    for (const w of new Set(nameWords(cp.name))) if (w.length >= 3) add(byWord, w, cp)
    for (const d of cp.domains || []) if (!isPublicMailDomain(d)) add(byDomain, String(d).toLowerCase(), cp)
  }
  return { byId, byInn, byKey, bySorted, byWord, byDomain, size: counterparties.length }
}

const softInnCandidates = (index, inn) => [...(index.byInn.get(noLeadingZeros(inn)) || [])].filter((cp) => softInn(cp.inn, inn))

// Основная запись среди дублей: не из чёрного списка, затем с договорами или участием в тендерах, затем больше связей
// (counterparty_relations). Не решилось — null.
export function pickMain(cps) {
  if (cps.length < 2) return cps[0]?.id ?? null
  let pool = cps.filter((c) => c.status !== 'blacklist')
  if (pool.length === 1) return pool[0].id
  if (!pool.length) return null
  const active = pool.filter((c) => (c.contracts || 0) + (c.tenders || 0) > 0)
  if (active.length === 1) return active[0].id
  if (active.length) pool = active
  const best = Math.max(...pool.map((c) => c.relations || 0))
  const top = pool.filter((c) => (c.relations || 0) === best)
  return top.length === 1 ? top[0].id : null
}

// Кандидаты для одной организации → [{ counterparty, reasons: [], flags: [], score }] по убыванию, не больше limit.
export function candidatesFor(org, index, { limit = 8 } = {}) {
  const found = new Map()
  const note = (cp, reason, flag = null) => {
    let c = found.get(cp.id)
    if (!c) found.set(cp.id, (c = { counterparty: cp, reasons: new Set(), flags: new Set() }))
    c.reasons.add(reason)
    if (flag) c.flags.add(flag)
    if (cp.status === 'blacklist') c.flags.add('blacklist')
  }
  const markDuplicates = (cps) => {
    if (cps.length < 2) return
    const main = pickMain(cps)
    for (const cp of cps) found.get(cp.id)?.flags.add(cp.id === main ? 'main_record' : 'duplicate')
  }

  const registryInn = cleanInn(org.inn)
  if (registryInn) {
    const soft = softInnCandidates(index, registryInn)
    const bad = isValidInn(registryInn) ? null : 'checksum'
    for (const cp of soft) note(cp, exactInn(cp.inn, registryInn) ? 'inn' : 'inn_soft', bad)
    markDuplicates(soft)
  }
  for (const hint of org.innHints || []) {
    const inn = cleanInn(hint.inn)
    if (!inn) continue
    const soft = softInnCandidates(index, inn)
    for (const cp of soft) {
      const agree = namesAgree(org.name, hint.name) || namesAgree(org.name, cp.name)
      note(cp, 'inn_hint', !isValidInn(inn) ? 'checksum' : (agree ? null : 'hint_name'))
    }
    markDuplicates(soft)
  }
  for (const inn of innsInName(org.name)) {
    const soft = softInnCandidates(index, inn)
    for (const cp of soft) note(cp, 'inn_in_name')
    markDuplicates(soft)
  }
  const sameName = new Set([...(index.byKey.get(nameKey(org.name)) || []), ...(index.bySorted.get(nameSortedKey(org.name)) || [])])
  for (const cp of sameName) note(cp, 'name')
  markDuplicates([...sameName])

  // Похожее название — только по редким словам (не «строй», «групп»): слово есть не больше чем у 5 контрагентов.
  const words = [...new Set(nameWords(org.name).filter((w) => w.length >= 4))]
  const counts = new Map()
  for (const w of words) {
    const set = index.byWord.get(w)
    if (!set || set.size > 5) continue
    for (const cp of set) counts.set(cp, (counts.get(cp) || 0) + 1)
  }
  for (const [cp, n] of counts) {
    if (found.has(cp.id)) continue
    const theirs = new Set(nameWords(cp.name).filter((w) => w.length >= 4))
    if (n / Math.max(1, new Set([...words, ...theirs]).size) >= 0.34) note(cp, 'name_similar')
  }
  for (const d of org.emailDomains || []) {
    if (isPublicMailDomain(d)) continue
    for (const cp of index.byDomain.get(d) || []) note(cp, 'domain')
  }

  const out = [...found.values()].map((c) => {
    const reasons = [...c.reasons].sort((a, b) => WEIGHT[b] - WEIGHT[a])
    let score = Math.max(...reasons.map((r) => WEIGHT[r])) + (reasons.length - 1) * 5
    if (c.flags.has('hint_name') || c.flags.has('checksum')) score -= 30
    if (c.flags.has('blacklist')) score -= 20
    if (c.flags.has('duplicate')) score -= 5
    return { counterparty: c.counterparty, reasons, flags: [...c.flags], score }
  })
  out.sort((a, b) => b.score - a.score || ((b.counterparty.contracts || 0) + (b.counterparty.tenders || 0)) - ((a.counterparty.contracts || 0) + (a.counterparty.tenders || 0))
    || (a.counterparty.number || 0) - (b.counterparty.number || 0))
  return out.slice(0, limit)
}

// Уверенный кандидат (см. начало файла) или null. claimed — id контрагентов, на которых претендует больше одной организации.
export function confidentCandidate(org, candidates, claimed = new Set()) {
  if (org.kind !== 'contractor') return null
  const inn = cleanInn(org.inn)
  if (!inn || !isValidInn(inn)) return null
  const byInn = candidates.filter((c) => c.reasons.includes('inn') || c.reasons.includes('inn_soft'))
  if (byInn.length !== 1) return null
  const c = byInn[0]
  if (!c.reasons.includes('inn') || c.counterparty.status === 'blacklist' || claimed.has(c.counterparty.id)) return null
  return c
}

// Отчёт по всем организациям-подрядчикам: кандидаты, уверенный, претензии двух организаций на одного контрагента.
// → { rows: [{ org, candidates, confident }], stats }
export function planReport(orgs, counterparties, { limit = 8 } = {}) {
  const index = buildIndex(counterparties)
  const contractors = orgs.filter((o) => o.kind === 'contractor')
  const rows = contractors.map((org) => ({ org, candidates: candidatesFor(org, index, { limit }) }))
  // Контрагент — сильный кандидат у двух и больше организаций: пометка у всех, уверенным не будет ни у кого.
  const strongBy = new Map()
  for (const r of rows) {
    for (const c of r.candidates) {
      if (!c.reasons.some((x) => STRONG.has(x))) continue
      strongBy.set(c.counterparty.id, (strongBy.get(c.counterparty.id) || 0) + 1)
    }
  }
  const claimed = new Set([...strongBy].filter(([, n]) => n > 1).map(([id]) => id))
  for (const r of rows) {
    for (const c of r.candidates) if (claimed.has(c.counterparty.id) && !c.flags.includes('claimed')) c.flags.push('claimed')
    r.confident = confidentCandidate(r.org, r.candidates, claimed)
  }
  const stats = {
    orgs: orgs.length,
    contractors: contractors.length,
    own: orgs.filter((o) => o.kind === 'own').length,
    confident: rows.filter((r) => r.confident).length,
    withStrong: rows.filter((r) => !r.confident && r.candidates.some((c) => c.reasons.some((x) => STRONG.has(x)))).length,
    weakOnly: rows.filter((r) => r.candidates.length && !r.candidates.some((c) => c.reasons.some((x) => STRONG.has(x)))).length,
    none: rows.filter((r) => !r.candidates.length).length,
    registryInn: contractors.filter((o) => cleanInn(o.inn)).length,
    innHints: contractors.filter((o) => (o.innHints || []).length).length,
    claimed: claimed.size,
  }
  return { rows, stats }
}

// Поиск контрагента администратором: «№ 12» / «12» — номер, от 5 цифр — ИНН, иначе слова названия (начало слов, любой порядок).
// → до limit контрагентов, точные — выше.
export function searchCounterparties(counterparties, query, { limit = 30 } = {}) {
  const q = String(query ?? '').trim()
  if (!q) return []
  const num = /^№?\s*(\d{1,7})$/.exec(q)
  const out = []
  if (num) {
    const n = Number(num[1])
    for (const cp of counterparties) if (cp.number === n) out.push({ cp, rank: 0 })
  }
  const qd = digits(q)
  if (qd.length >= 5 && qd.length === q.replace(/[\s№]/g, '').length) {
    for (const cp of counterparties) if (digits(cp.inn).includes(qd)) out.push({ cp, rank: exactInn(cp.inn, qd) ? 1 : 2 })
  } else if (!num) {
    const words = nameWords(q)
    if (words.length) {
      for (const cp of counterparties) {
        const theirs = nameWords(cp.name)
        if (words.every((w) => theirs.some((t) => t.startsWith(w)))) out.push({ cp, rank: nameKey(cp.name) === nameKey(q) ? 1 : 3 })
      }
    }
  }
  const seen = new Set()
  return out.sort((a, b) => a.rank - b.rank || (a.cp.number || 0) - (b.cp.number || 0))
    .filter(({ cp }) => !seen.has(cp.id) && seen.add(cp.id))
    .slice(0, limit).map(({ cp }) => cp)
}
