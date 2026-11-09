// Суммы заявки на ДС — ячейка «Сумма, руб. с НДС 22%» (решения пользователя 06.11.2026, образец — картинка): один блок
// из двух частей у КАЖДОЙ заявки, части разделены двойной чертой; тип ДС суммы между частями не переносит.
//   Верхняя часть: «Было ПСДЦ» (amount_before, прежнее «Было подано»), «ДС подрядчика» (amount_contractor),
//     «Согласовано ДС ОСП» (amount_after, прежнее «Утверждено») и итог «Дельта к ПСДЦ».
//   Нижняя часть: «Было ВОР подрядчик» (vor_amount_before), «Стало ВОР ОСП» (vor_amount_after) и «Дельта ОСП».
// Новые колонки — миграция 20270104; она же разово перенесла суммы «ДС по тендеру» в нижнюю часть. Без неё — только
// верхняя часть, «ДС подрядчика» не вводится (columns = false).
import { amountChange, formatAmount, roundMoney } from './money.js'

export const AMOUNT_LABEL = {
  amount_before: 'Было ПСДЦ',
  amount_contractor: 'ДС подрядчика',
  amount_after: 'Согласовано ДС ОСП',
  vor_amount_before: 'Было ВОР подрядчик',
  vor_amount_after: 'Стало ВОР ОСП',
}
export const AMOUNT_FIELDS = Object.keys(AMOUNT_LABEL)
// Колонки миграции 20270104: без неё их нет ни в форме, ни в записи.
export const NEW_AMOUNT_FIELDS = ['amount_contractor', 'vor_amount_before', 'vor_amount_after']

// Колонки 20270104 в базе есть — видно по строкам выборки «*».
export const hasAmountColumns = (rows) => Array.isArray(rows) && rows.some(r => r && 'vor_amount_before' in r)

// Колонки нет в базе (явный перечень полей до миграции): PostgreSQL 42703, PostgREST PGRST204.
export const isMissingColumnError = (err) => err?.code === '42703' || err?.code === 'PGRST204'
  || /column .* does not exist|could not find .* column/i.test(String(err?.message || ''))

const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Дельта «стало − было»: change > 0 — дороже (↑), < 0 — дешевле (↓), 0 — без изменений. pct — от модуля «было»
// (суммы бывают отрицательными: ДС на уменьшение стоимости), со знаком change; «было» 0 — без процента.
// Нет одной из сумм — null.
export function amountDelta(base, value) {
  const { diff, pct } = amountChange(num(base), num(value))
  if (diff == null) return null
  return { change: diff === 0 ? 0 : -diff, pct }
}

// Части блока сверху вниз: [{ key: 'psdc' | 'vor', rows }]. Строка:
//   value — сумма (field — колонка, которую правят прямо в блоке; null — только показ); main — основная сумма:
//           полосой и полужирным, это «ДС подрядчика» и «Согласовано ДС ОСП» (решение пользователя 06.11.2026,
//           позже: прежде полосой шли «Было ПСДЦ» и «Было ВОР подрядчик»), остальные — обычные;
//   delta — дельта (tone: 'contractor' — подрядчика к ПСДЦ, 'osp' — решение ОСП);
//   total — итог «Дельта к ПСДЦ» (тонкой чертой от строк выше).
// Дельта, которую не из чего посчитать, в список не попадает: с «ДС подрядчика» появятся, когда сумму внесут.
export function amountSections(req, { columns = true } = {}) {
  const v = (field) => num(req?.[field])
  const rows = (list) => list.filter(r => (r.kind === 'delta' || r.kind === 'total' ? r.delta != null : true))
  const before = v('amount_before')
  const contractor = columns ? v('amount_contractor') : null
  const after = v('amount_after')
  const psdc = rows([
    { kind: 'value', label: AMOUNT_LABEL.amount_before, field: 'amount_before', value: before },
    { kind: 'value', main: true, label: AMOUNT_LABEL.amount_contractor, field: columns ? 'amount_contractor' : null, value: contractor },
    { kind: 'delta', tone: 'contractor', label: 'Дельта к ПСДЦ', delta: amountDelta(before, contractor) },
    { kind: 'value', main: true, label: AMOUNT_LABEL.amount_after, field: 'amount_after', value: after },
    { kind: 'delta', tone: 'osp', label: 'Дельта ОСП', delta: amountDelta(contractor, after) },
    { kind: 'total', label: 'Дельта к ПСДЦ', delta: amountDelta(before, after) },
  ])
  if (!columns) return [{ key: 'psdc', rows: psdc }]
  const vorBefore = v('vor_amount_before')
  const vorAfter = v('vor_amount_after')
  const vor = rows([
    { kind: 'value', label: AMOUNT_LABEL.vor_amount_before, field: 'vor_amount_before', value: vorBefore },
    { kind: 'value', label: AMOUNT_LABEL.vor_amount_after, field: 'vor_amount_after', value: vorAfter },
    { kind: 'delta', tone: 'osp', label: 'Дельта ОСП', delta: amountDelta(vorBefore, vorAfter) },
  ])
  return [{ key: 'psdc', rows: psdc }, { key: 'vor', rows: vor }]
}

// Процент — два знака, как на образце: «+16,38%», «−2,55%», «−10,00%».
const PCT = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const sign = (n) => (n < 0 ? '−' : '+')

// Подписи дельты: abs — «↑ +4 616 230,75 ₽», pct — «+16,38%» (нет процента — null); без изменений — «без изменений».
export function deltaText(delta) {
  if (!delta) return null
  if (delta.change === 0) return { dir: 'zero', abs: 'без изменений', pct: null }
  const dir = delta.change > 0 ? 'up' : 'down'
  return {
    dir,
    abs: `${dir === 'up' ? '↑' : '↓'} ${sign(delta.change)}${formatAmount(Math.abs(delta.change))} ₽`,
    pct: delta.pct != null && Number.isFinite(delta.pct) ? `${sign(delta.change)}${PCT.format(Math.abs(delta.pct))}%` : null,
  }
}

// «Было» и «утверждено» заявки одним числом — для отчёта «Заявки на ДС» и карточки контрагента: ПСДЦ + ВОР
// подрядчика и ДС ОСП + ВОР ОСП. После 20270104 суммы «ДС по тендеру» лежат в ВОР — без этого они выпали бы из итогов.
// Нет ни одной суммы — null.
export function requestTotals(req) {
  const sum = (...xs) => {
    const vals = xs.map(num).filter(x => x != null)
    return vals.length ? roundMoney(vals.reduce((a, b) => a + b, 0)) : null
  }
  return {
    before: sum(req?.amount_before, req?.vor_amount_before),
    after: sum(req?.amount_after, req?.vor_amount_after),
  }
}

// Выгрузка в Excel: суммы обеих частей и их итоговые дельты («стало − было», как на экране; процент — числом).
export const AMOUNT_EXPORT_COLUMNS = [
  'Было ПСДЦ, ₽ (с НДС 22%)', 'ДС подрядчика, ₽ (с НДС 22%)', 'Согласовано ДС ОСП, ₽ (с НДС 22%)',
  'Дельта к ПСДЦ, ₽', 'Дельта к ПСДЦ, %',
  'Было ВОР подрядчик, ₽ (с НДС 22%)', 'Стало ВОР ОСП, ₽ (с НДС 22%)', 'Дельта ОСП по ВОР, ₽', 'Дельта ОСП по ВОР, %',
]
export function amountExportCells(req) {
  const v = (field) => num(req?.[field]) ?? ''
  const d = (a, b) => {
    const delta = amountDelta(req?.[a], req?.[b])
    return [delta ? delta.change : '', delta?.pct != null ? Number(delta.pct.toFixed(2)) : '']
  }
  const values = [
    v('amount_before'), v('amount_contractor'), v('amount_after'), ...d('amount_before', 'amount_after'),
    v('vor_amount_before'), v('vor_amount_after'), ...d('vor_amount_before', 'vor_amount_after'),
  ]
  return Object.fromEntries(AMOUNT_EXPORT_COLUMNS.map((col, i) => [col, values[i]]))
}
