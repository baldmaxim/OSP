// «Планы затрат» → «Документы» → «Расчёт ПЗ» (миграции 20261116_cost_plan_calc, 20261121_cost_plan_calc_objects).
// Чистые помощники — без запросов. Устройство вкладки (решение пользователя 30.10, схема с фото):
//   • сверху — общие инструкции «Прямые затраты» и «КП до перекидок» (файлы якорей section_templates);
//   • ниже — карточка на объект: слева документы объекта по расчёту (те же два вида), справа «Компенсация НДС» и под
//     ней «Инфляция» — да / нет, процент и подтверждающий документ из «Документов» карточки объекта.
// Запросы — services/costPlanCalc.js.
import { objectLabel } from './costPlanEconomists.js'

export const COST_PLAN_CALC_MIGRATION = '20261116_cost_plan_calc'
export const COST_PLAN_CALC_OBJECTS_MIGRATION = '20261121_cost_plan_calc_objects'
export const COST_PLAN_CALC_FILES_HINT =
  `Инструкции можно будет загрузить после обновления базы (миграция ${COST_PLAN_CALC_MIGRATION}).`
export const COST_PLAN_COMPENSATION_HINT =
  `Компенсацию НДС и инфляцию можно будет указать после обновления базы (миграция ${COST_PLAN_CALC_MIGRATION}).`
export const COST_PLAN_COMPENSATION_LEGACY_HINT =
  `«Да / нет», процент и подтверждающий документ — после обновления базы (миграция ${COST_PLAN_CALC_OBJECTS_MIGRATION}); пока — только примечание.`

// Виды документов расчёта. code — строка section_templates (якорь общей инструкции, заводит 20261116), category —
// doc_category документов объекта (s3_documents объекта; загружает только администратор — osp-api CATEGORY_RULES).
export const COST_PLAN_CALC_SECTIONS = [
  { key: 'direct', code: 'cost_plan_direct_costs', category: 'cost_plan_direct_costs', label: 'Прямые затраты' },
  { key: 'kp', code: 'cost_plan_kp_before_transfers', category: 'cost_plan_kp_before_transfers', label: 'КП до перекидок' },
]
// doc_category файлов инструкций (owner_type 'general', owner_id — якорь).
export const COST_PLAN_CALC_CATEGORY = 'cost_plan_calc'

// Пункты компенсации — справа в карточке объекта, сверху вниз; колонки cost_plan_compensation — `${key}_*`.
export const COMPENSATION_ITEMS = [
  { key: 'vat', label: 'Компенсация НДС', docLabel: 'Подтверждающий ДС', of: 'НДС' },
  { key: 'inflation', label: 'Инфляция', docLabel: 'Подтверждающий документ', of: 'инфляции' },
]

// Тот же предел — CHECK в базе.
export const COMPENSATION_NOTE_MAX = 2000

const byRu = (a, b) => a.localeCompare(b, 'ru')
// Текст примечания: переводы строк — \n, без пробелов в конце строк и по краям; пусто — null.
const note = (v) => {
  const s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+$/gm, '').trim()
  return s || null
}
const flag = (v) => (v === true || v === false ? v : null)

// Процент из поля: «2», «1,5», «2 %» → число; пусто → null; не число от 0 (не включая) до 100 — undefined.
export function parsePercent(v) {
  const s = String(v ?? '').replace(/[\s\u00a0%]/g, '').replace(',', '.')
  if (!s) return null
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return undefined
  const n = Number(s)
  return n > 0 && n <= 100 ? n : undefined
}

// 2 → «2 %», 1.5 → «1,5 %» (пробел неразрывный).
export function formatPercent(v) {
  if (v == null || v === '') return ''
  const n = Number(v)
  return Number.isFinite(n) ? `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}\u00a0%` : ''
}

// Пункт компенсации из строки cost_plan_compensation (строки нет — всё пусто).
function itemOf(row, key) {
  const percent = row?.[`${key}_percent`]
  return {
    compensated: flag(row?.[`${key}_compensated`]),
    percent: percent == null ? null : Number(percent),
    documentId: row?.[`${key}_document_id`] || null,
    note: note(row?.[`${key}_note`]),
  }
}
const itemFilled = (it) => it.compensated !== null || Boolean(it.note)

// Карточки объектов: объекты основного строительства и любой объект со сведениями или документами расчёта
// (переведён на гарантию — ничего не пропадает). objects — [{ id, name, status }], rows — cost_plan_compensation,
// files — документы объектов (s3_documents: owner_id, doc_category) в порядке показа.
// → [{ id, label, vat, inflation, files: { direct: [...], kp: [...] }, filled, hasFiles }] по названию.
export function calcObjectCards(objects = [], rows = [], files = []) {
  const byObject = new Map(rows.map(r => [r.object_id, r]))
  const filesBy = new Map()
  for (const f of files) {
    const k = `${f.owner_id}|${f.doc_category}`
    if (!filesBy.has(k)) filesBy.set(k, [])
    filesBy.get(k).push(f)
  }
  const cards = []
  for (const o of objects) {
    const r = byObject.get(o.id)
    const vat = itemOf(r, 'vat')
    const inflation = itemOf(r, 'inflation')
    const docs = Object.fromEntries(COST_PLAN_CALC_SECTIONS.map(s => [s.key, filesBy.get(`${o.id}|${s.category}`) || []]))
    const filled = itemFilled(vat) || itemFilled(inflation)
    const hasFiles = Object.values(docs).some(list => list.length > 0)
    if (o.status !== 'main_construction' && !filled && !hasFiles) continue
    cards.push({ id: o.id, label: objectLabel(o.name), vat, inflation, files: docs, filled, hasFiles })
  }
  return cards.sort((a, b) => byRu(a.label, b.label))
}

// Поиск объекта: без регистра и ё.
const fold = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
export const objectMatches = (label, query) => !fold(query) || fold(label).includes(fold(query))

// Поля формы карточки: { vat: { state: 'yes'|'no'|'', percent, documentId, note }, inflation: {…} }.
export function compensationForm(card) {
  const toForm = (it) => ({
    state: it.compensated === true ? 'yes' : it.compensated === false ? 'no' : '',
    percent: it.percent == null ? '' : String(it.percent).replace('.', ','),
    documentId: it.documentId || '',
    note: it.note || '',
  })
  return { vat: toForm(card.vat), inflation: toForm(card.inflation) }
}

// Форма → { value, empty } (empty — ничего не указано: строку удалить) или { error }. detailed=false — колонок
// 20261121 ещё нет: только примечания. Процент и документ — только при «да».
export function parseCompensation(form, { detailed = true } = {}) {
  const value = {}
  for (const { key, of } of COMPENSATION_ITEMS) {
    const f = form[key] || {}
    const text = note(f.note)
    if (text && text.length > COMPENSATION_NOTE_MAX) return { error: `Примечание по ${of} — не больше ${COMPENSATION_NOTE_MAX} знаков.` }
    value[`${key}_note`] = text
    if (!detailed) continue
    const yes = f.state === 'yes'
    const percent = yes ? parsePercent(f.percent) : null
    if (percent === undefined) return { error: `Процент по ${of} — число больше 0 и не больше 100, например 2 или 1,5.` }
    value[`${key}_compensated`] = yes ? true : f.state === 'no' ? false : null
    value[`${key}_percent`] = percent
    value[`${key}_document_id`] = yes && f.documentId ? f.documentId : null
  }
  const empty = COMPENSATION_ITEMS.every(({ key }) => !value[`${key}_note`] && (value[`${key}_compensated`] ?? null) === null)
  return { value, empty }
}

const ruDate = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '')
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ''
}

// Документ объекта для выбора и показа: ДС — названием («ДС № 4»), договор генподряда — с номером; у обоих дата.
export function objectDocLabel(doc) {
  if (!doc) return ''
  const contract = doc.document_type === 'general_contract'
  const name = String(doc.name || '').trim() || (contract ? 'Договор генподряда' : 'Документ')
  const number = String(doc.document_number || '').trim()
  const num = contract && number && !name.includes(number) ? ` № ${number}` : ''
  const date = ruDate(doc.document_date)
  return `${name}${num}${date ? ` от ${date}` : ''}`
}

// Варианты подтверждающего документа: договор генподряда, затем ДС — в порядке «Документов» карточки объекта.
export function objectDocOptions(docs = []) {
  const rank = (d) => (d.document_type === 'general_contract' ? 0 : 1)
  return docs
    .filter(d => !d.parent_document_id && (d.document_type === 'general_contract' || d.document_type === 'additional_agreement'))
    .sort((a, b) => rank(a) - rank(b)
      || (a.order_number ?? 0) - (b.order_number ?? 0)
      || String(a.created_at || '').localeCompare(String(b.created_at || '')))
}

// Документ в карточке объекта: вкладка «Документы», строка документа подсвечена (ObjectDetailPage, ?doc=).
export const objectDocHref = (objectId, docId) =>
  `/general/objects/${objectId}?tab=documents${docId ? `&doc=${encodeURIComponent(docId)}` : ''}`
