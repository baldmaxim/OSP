// Отчёт «Подрядчики» (Отчёты → Тендеры → Подрядчики; до 29.10.2026 — «Победители»): по каждому подрядчику —
// участие в тендерах, отправленные КП, отказы, победы, заключённые договоры; фильтры и разрез по подразделениям.
//
// Тендеры — основные (не на материалы) и не удалённые, как во всех отчётах «Тендеров»; область объектов
// пользователя уже учтена в выборке страницы.
// Участие — тендер, где подрядчик участник (tender_counterparties), прислал КП или назван победителем.
// КП отправлено — тендер, где у участника статус «КП предоставлено» или загружен файл КП
//   (tender_proposal_files, file_kind='commercial_proposal'): на копии прода 15.10 у 101 «КП предоставлено» файла
//   нет, а у 25 пар с файлом статус другой. Файлы (с новыми версиями) — отдельным числом.
// Отказ — статус «Отказ» без КП.
// Победа — завершённый тендер, где подрядчик среди победителей: tender_winners (несколько победителей по корпусам),
//   нет строк — tenders.winner_counterparty_id, как в карточке тендера. До 29.10 считался только основной победитель.
// % побед — победы / завершённые тендеры, где подрядчик прислал КП или победил (незавершённые ещё не решены).
// Договоры и сумма — как раньше в «Победителях»: строки «Договоров и ДС» основного строительства, где контрагент —
//   сторона (contracts.counterparty_id); заключён — статус «Завершено»; сумма по валютам, итог — ≈ в рублях.
// Подразделения подрядчика — подразделения его видов работ (utils/workTypeDivisions.js, как в реестре контрагентов).
import { NO_VOR_DIVISION } from './vorDivisions.js'
import { WORK_TYPE_DIVISIONS, WORK_TYPE_DIVISION_LABEL, matchesDivisions, workTypesDivisions } from './workTypeDivisions.js'
import { counterpartySearchIndex, searchCounterparties } from './counterpartySearch.js'
import { totalRub } from './reportCurrency.js'

const isClosedTender = (t) => t?.status === 'Завершен'
const MLN = 1_000_000

// Отбор по сумме заключённых договоров (≈ ₽). Границы готовых диапазонов — [min, max) в млн ₽, «до 10 млн» —
// только с договорами (больше нуля): без договоров — свой пункт.
export const AMOUNT_PRESETS = [
  { value: 'any', label: 'Любая' },
  { value: 'none', label: 'Без договоров' },
  { value: 'lt10', label: 'до 10 млн', min: 0, max: 10 },
  { value: '10-50', label: '10–50 млн', min: 10, max: 50 },
  { value: '50-100', label: '50–100 млн', min: 50, max: 100 },
  { value: '100-500', label: '100–500 млн', min: 100, max: 500 },
  { value: 'gt500', label: 'от 500 млн', min: 500 },
  { value: 'custom', label: 'Свой диапазон' },
]

// «12,5» / «12.5» / «1 200» → число (млн); пусто или не число — null.
export function parseMillions(text) {
  const s = String(text ?? '').replace(/\s/g, '').replace(',', '.')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// Проходит ли сумма (≈ ₽) отбор { preset, from, to } (from / to — текст в млн ₽, только у «Своего диапазона»,
// обе границы включительно; пустая граница — без ограничения, но договоры должны быть).
export function amountMatches(rub, { preset = 'any', from = '', to = '' } = {}) {
  const amount = Number(rub) || 0
  if (preset === 'any') return true
  if (preset === 'none') return amount <= 0
  if (amount <= 0) return false
  if (preset === 'custom') {
    const lo = parseMillions(from)
    const hi = parseMillions(to)
    return (lo == null || amount >= lo * MLN) && (hi == null || amount <= hi * MLN)
  }
  const p = AMOUNT_PRESETS.find((x) => x.value === preset)
  if (!p) return true
  return amount >= (p.min || 0) * MLN && (p.max == null || amount < p.max * MLN)
}

export const isAmountFilterActive = ({ preset = 'any', from = '', to = '' } = {}) =>
  preset !== 'any' && !(preset === 'custom' && parseMillions(from) == null && parseMillions(to) == null)

// Победители завершённого тендера: tender_winners, нет строк — основной победитель.
function winnersOf(tender, winnersByTender) {
  if (!isClosedTender(tender)) return []
  const list = winnersByTender.get(tender.id)
  if (list?.size) return [...list]
  return tender.winner_counterparty_id ? [tender.winner_counterparty_id] : []
}

// Договоры по контрагенту — как прежний отчёт «Победители».
function contractsByCounterparty(contracts) {
  const acc = new Map()
  for (const c of contracts || []) {
    const id = c.counterparty_id
    if (!id) continue
    if (!acc.has(id)) acc.set(id, { total: 0, signed: 0, totalByCur: {}, signedByCur: {} })
    const s = acc.get(id)
    const amount = Number(c.contract_amount) || 0
    const cur = c.currency || 'RUB'
    s.total += 1
    s.totalByCur[cur] = (s.totalByCur[cur] || 0) + amount
    if (c.status === 'completed') {
      s.signed += 1
      s.signedByCur[cur] = (s.signedByCur[cur] || 0) + amount
    }
  }
  return acc
}

// Строки отчёта — по одной на подрядчика, у которого есть участие в тендерах выборки.
// tenders — основные тендеры (с objects.status, status, winner_counterparty_id, winner.name);
// participants — tender_counterparties { tender_id, counterparty_id, status };
// kpFiles — файлы КП { tender_id, counterparty_id }; winners — tender_winners { tender_id, counterparty_id } или null;
// counterparties — { id, name, inn, work_type, status, deleted_at }; contracts — как в «Договорах» отчёта;
// divisionByName — Map «вид работ → подразделение» (divisionByWorkType).
export function buildContractorRows({
  tenders = [], participants = [], kpFiles = [], winners = null, counterparties = [], contracts = [],
  divisionByName = new Map(),
} = {}) {
  const tenderById = new Map(tenders.map((t) => [t.id, t]))
  const winnersByTender = new Map()
  for (const w of winners || []) {
    if (!tenderById.has(w.tender_id) || !w.counterparty_id) continue
    if (!winnersByTender.has(w.tender_id)) winnersByTender.set(w.tender_id, new Set())
    winnersByTender.get(w.tender_id).add(w.counterparty_id)
  }

  // Подрядчик → тендер → { status, files, won }
  const links = new Map()
  const link = (cpId, tenderId) => {
    if (!links.has(cpId)) links.set(cpId, new Map())
    const byTender = links.get(cpId)
    if (!byTender.has(tenderId)) byTender.set(tenderId, { status: null, files: 0, won: false })
    return byTender.get(tenderId)
  }
  for (const p of participants) {
    if (p.counterparty_id && tenderById.has(p.tender_id)) link(p.counterparty_id, p.tender_id).status = p.status || 'request_sent'
  }
  for (const f of kpFiles) {
    if (f.counterparty_id && tenderById.has(f.tender_id)) link(f.counterparty_id, f.tender_id).files += 1
  }
  const winnerNames = new Map()
  for (const t of tenders) {
    for (const cpId of winnersOf(t, winnersByTender)) {
      link(cpId, t.id).won = true
      if (t.winner_counterparty_id === cpId && t.winner?.name) winnerNames.set(cpId, t.winner.name)
    }
  }

  const cpById = new Map(counterparties.map((c) => [c.id, c]))
  const contractStats = contractsByCounterparty(contracts)
  const rows = []
  for (const [cpId, byTender] of links) {
    const cp = cpById.get(cpId)
    const row = {
      id: cpId,
      name: cp?.name || winnerNames.get(cpId) || 'Контрагент удалён',
      inn: cp?.inn || '',
      workType: cp?.work_type || '',
      cpStatus: cp?.status || null,
      deleted: !cp || !!cp.deleted_at,
      divisions: workTypesDivisions(cp?.work_type, divisionByName),
      tenders: byTender.size,
      kp: 0,
      kpFiles: 0,
      declined: 0,
      wins: 0,
      winsConst: 0,
      winsWar: 0,
      closedEngaged: 0,
      wonTenderIds: [],
      signedContracts: 0,
      contractsTotal: 0,
      signedByCur: {},
      signedAmountRub: 0,
      hasForeign: false,
    }
    for (const [tenderId, l] of byTender) {
      const tender = tenderById.get(tenderId)
      const sent = l.files > 0 || l.status === 'proposal_provided'
      if (sent) row.kp += 1
      row.kpFiles += l.files
      if (!sent && l.status === 'declined') row.declined += 1
      if (l.won) {
        row.wins += 1
        row.wonTenderIds.push(tenderId)
        if (tender.objects?.status === 'main_construction') row.winsConst += 1
        else if (tender.objects?.status === 'warranty_service') row.winsWar += 1
      }
      if (isClosedTender(tender) && (sent || l.won)) row.closedEngaged += 1
    }
    row.winRate = row.closedEngaged > 0 ? row.wins / row.closedEngaged : null
    row.responseRate = row.tenders > 0 ? row.kp / row.tenders : null
    const cs = contractStats.get(cpId)
    if (cs) {
      row.signedContracts = cs.signed
      row.contractsTotal = cs.total
      row.signedByCur = cs.signedByCur
      row.signedAmountRub = totalRub(cs.signedByCur)
      row.hasForeign = Object.keys(cs.signedByCur).some((c) => c !== 'RUB' && cs.signedByCur[c])
    }
    rows.push(row)
  }
  return rows
}

// Кого показывать: всех участников, приславших КП или победителей.
export const SHOW_OPTIONS = [
  { value: 'all', label: 'Все участники' },
  { value: 'kp', label: 'Прислали КП' },
  { value: 'winners', label: 'Победители' },
]

// Отбор строк: кого показывать, сумма договоров и поиск (как в реестре контрагентов: регистр, кавычки, раскладка,
// опечатки). Возвращает { rows, fix } — fix как у searchCounterparties (поиск в другой раскладке / с опечатками).
// Подразделение — отдельно (filterByDivision): разрез по подразделениям считается до него.
export function filterContractorRows(rows, { show = 'all', amount, search = '' } = {}) {
  let list = rows
  if (show === 'kp') list = list.filter((r) => r.kp > 0)
  else if (show === 'winners') list = list.filter((r) => r.wins > 0)
  if (amount) list = list.filter((r) => amountMatches(r.signedAmountRub, amount))
  if (!String(search).trim()) return { rows: list, fix: null }
  const found = searchCounterparties(list, search, searchIndexOf)
  return { rows: found.items, fix: found.fix }
}

// Подразделение по видам работ: '' — все, NO_VOR_DIVISION — без подразделения.
export const filterByDivision = (rows, division) =>
  (division ? rows.filter((r) => matchesDivisions(r.divisions, [division])) : rows)

const searchIndexCache = new WeakMap()
function searchIndexOf(row) {
  let index = searchIndexCache.get(row)
  if (!index) {
    index = counterpartySearchIndex({ name: row.name, work_type: row.workType, inn: row.inn })
    searchIndexCache.set(row, index)
  }
  return index
}

// Итоги по выборке строк.
export function summarizeContractors(rows) {
  const s = {
    contractors: rows.length, withKp: 0, participations: 0, kp: 0, kpFiles: 0, declined: 0,
    wins: 0, winners: 0, closedWithWinner: 0, closedEngaged: 0,
    withContracts: 0, signedContracts: 0, signedAmountRub: 0, anyForeign: false,
  }
  const wonTenders = new Set()
  for (const r of rows) {
    s.participations += r.tenders
    s.kp += r.kp
    s.kpFiles += r.kpFiles
    s.declined += r.declined
    s.wins += r.wins
    s.closedEngaged += r.closedEngaged
    s.signedContracts += r.signedContracts
    s.signedAmountRub += r.signedAmountRub
    if (r.kp > 0) s.withKp += 1
    if (r.wins > 0) s.winners += 1
    if (r.signedContracts > 0) s.withContracts += 1
    if (r.hasForeign) s.anyForeign = true
    for (const id of r.wonTenderIds) wonTenders.add(id)
  }
  s.closedWithWinner = wonTenders.size
  s.winRate = s.closedEngaged > 0 ? s.wins / s.closedEngaged : null
  s.responseRate = s.participations > 0 ? s.kp / s.participations : null
  return s
}

// Разрез по подразделениям: подрядчик с видами работ разных подразделений считается в каждом, без подразделения —
// в «Не указано» (последней строкой). Все подразделения — даже пустые, чтобы видеть, где подрядчиков нет.
export function divisionBreakdown(rows) {
  const keys = [...WORK_TYPE_DIVISIONS.map((d) => d.value), NO_VOR_DIVISION]
  const acc = new Map(keys.map((k) => [k, []]))
  for (const r of rows) {
    if (!r.divisions.length) acc.get(NO_VOR_DIVISION).push(r)
    for (const d of r.divisions) acc.get(d)?.push(r)
  }
  return keys.map((value) => {
    const s = summarizeContractors(acc.get(value))
    return {
      value,
      label: WORK_TYPE_DIVISION_LABEL[value] || 'Не указано',
      contractors: s.contractors, kp: s.kp, wins: s.wins, winners: s.winners,
      signedAmountRub: s.signedAmountRub, anyForeign: s.anyForeign, winRate: s.winRate,
    }
  })
}

// Столбцы, по которым сортируется таблица; по умолчанию — как прежний рейтинг победителей: победы, затем сумма.
export const SORT_KEYS = {
  name: (r) => r.name,
  tenders: (r) => r.tenders,
  kp: (r) => r.kp,
  wins: (r) => r.wins,
  winRate: (r) => r.winRate,
  contracts: (r) => r.signedContracts,
  amount: (r) => r.signedAmountRub,
}
export const DEFAULT_SORT = { key: 'wins', dir: 'desc' }

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true })

export function sortContractorRows(rows, { key = DEFAULT_SORT.key, dir = DEFAULT_SORT.dir } = {}) {
  const get = SORT_KEYS[key] || SORT_KEYS.wins
  const sign = dir === 'asc' ? 1 : -1
  const tie = (a, b) => (b.wins - a.wins) || (b.signedAmountRub - a.signedAmountRub) || (b.kp - a.kp)
    || collator.compare(a.name, b.name)
  return [...rows].sort((a, b) => {
    const va = get(a)
    const vb = get(b)
    // Пустое значение (% побед без завершённых тендеров) — всегда в конце.
    if (va == null || vb == null) {
      if (va == null && vb != null) return 1
      if (vb == null && va != null) return -1
      return tie(a, b)
    }
    const cmp = typeof va === 'string' ? collator.compare(va, vb) : va - vb
    return cmp !== 0 ? sign * cmp : tie(a, b)
  })
}
