// «Планы затрат» → «Документы» → «Расчёт ПЗ» (миграция 20261116_cost_plan_calc). Чистые помощники — без запросов:
// подвкладки с файлами расчёта и таблица «Компенсация НДС и инфляции по объектам». Запросы —
// services/costPlanCalc.js.
import { objectLabel } from './costPlanEconomists.js'

export const COST_PLAN_CALC_MIGRATION = '20261116_cost_plan_calc'
export const COST_PLAN_CALC_FILES_HINT =
  `Файлы можно будет загрузить после обновления базы (миграция ${COST_PLAN_CALC_MIGRATION}).`
export const COST_PLAN_COMPENSATION_HINT =
  `Сведения о компенсации по объектам появятся после обновления базы (миграция ${COST_PLAN_CALC_MIGRATION}).`

// Подвкладки: у каждой — строка section_templates (якорь списка файлов, заводит миграция) и свой список файлов.
export const COST_PLAN_CALC_SECTIONS = [
  { key: 'direct', code: 'cost_plan_direct_costs', label: 'Прямые затраты' },
  { key: 'kp', code: 'cost_plan_kp_before_transfers', label: 'КП до перекидок' },
]
// doc_category файлов расчёта: отдельная от шаблонов разделов — там новый файл заменяет прежний, здесь — список.
export const COST_PLAN_CALC_CATEGORY = 'cost_plan_calc'

// Тот же предел — CHECK в базе.
export const COMPENSATION_NOTE_MAX = 2000

const byRu = (a, b) => a.localeCompare(b, 'ru')
// Текст сведений: переводы строк — \n, без пробелов в конце строк и по краям; пусто — null.
const note = (v) => {
  const s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+$/gm, '').trim()
  return s || null
}

// Строки таблицы: объекты основного строительства и любой объект, у которого сведения уже внесены (переведён на
// гарантию — сведения не пропадают). objects — [{ id, name, status }], rows — строки cost_plan_compensation.
// → [{ id, label, vat, inflation, filled }] по названию.
export function compensationTable(objects = [], rows = []) {
  const byObject = new Map(rows.map(r => [r.object_id, r]))
  return objects
    .filter(o => o.status === 'main_construction' || byObject.has(o.id))
    .map(o => {
      const r = byObject.get(o.id)
      const vat = note(r?.vat_note)
      const inflation = note(r?.inflation_note)
      return { id: o.id, label: objectLabel(o.name), vat, inflation, filled: Boolean(vat || inflation) }
    })
    .sort((a, b) => byRu(a.label, b.label))
}

// Поля формы → { value: { vat_note, inflation_note }, empty } (empty — оба пустые: строку удалить) или { error }.
export function parseCompensation({ vat, inflation }) {
  const value = { vat_note: note(vat), inflation_note: note(inflation) }
  for (const [field, title] of [['vat_note', 'НДС'], ['inflation_note', 'инфляции']]) {
    if (value[field] && value[field].length > COMPENSATION_NOTE_MAX) {
      return { error: `Сведения по ${title} — не больше ${COMPENSATION_NOTE_MAX} знаков.` }
    }
  }
  return { value, empty: !value.vat_note && !value.inflation_note }
}
