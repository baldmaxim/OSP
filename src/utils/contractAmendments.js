// Дополнительные соглашения: типы документов, дерево, наследование условий и
// расчёт актуальных сумм.
//
// Одна реализация правил на форму, реестр и Excel-импорт — иначе ручное
// создание и загрузка файлом разойдутся в поведении.
//
// Договоры и ДС хранятся в одной таблице contracts. Документ опознаётся по
// record_type, связь с изменяемым документом — parent_contract_id, корень
// дерева — root_contract_id (заполняет триггер), глобальный ID — display_id.
//
// ВАЖНО про наследование: ДС меняет только те поля, которые перечислены в
// changed_fields. Пустое значение поля НЕ означает изменение — иначе ДС,
// созданное ради правки суммы, молча вернуло бы прежний НДС.

export const DOC_TYPE = {
  CONTRACT: 'dp',
  CHANGE: 'ds_vor',
  EXTRA: 'ds_extra',
}

export const DOC_TYPES = [
  { value: DOC_TYPE.CONTRACT, label: 'Договор', short: 'Договор' },
  { value: DOC_TYPE.CHANGE, label: 'ДС на изменение ВОР', short: 'Изменение ВОР' },
  { value: DOC_TYPE.EXTRA, label: 'ДС на дополнительные работы', short: 'Доп. работы' },
]

export const DOC_TYPE_LABEL = Object.fromEntries(DOC_TYPES.map(t => [t.value, t.label]))
export const DOC_TYPE_SHORT = Object.fromEntries(DOC_TYPES.map(t => [t.value, t.short]))

// Статус, с которого документ начинает влиять на актуальные условия ветки.
export const COMPLETED_STATUS = 'completed'

export const isAmendment = (doc) => !!doc && doc.record_type !== DOC_TYPE.CONTRACT
export const isCompleted = (doc) => doc?.status === COMPLETED_STATUS
export const isLive = (doc) => !!doc && !doc.deleted_at

// Коммерческие условия, которые ДС вправе переопределить. Идентичность договора
// (номер, дата заключения, контрагент, объект) в список НЕ входит: ДС не должно
// переназначить договор другому контрагенту.
export const OVERRIDABLE_FIELDS = [
  'contract_amount',
  'gp_amount',
  'currency',
  'vat_rate',
  'amount_includes_vat',
  'bsm',
  'work_name',
  'work_start_date',
  'work_end_date',
  'warranty_retention_percent',
  'warranty_retention_period',
  'warranty_period',
]

export const OVERRIDABLE_FIELD_LABEL = {
  contract_amount: 'Сумма',
  gp_amount: 'Сумма генподряда',
  currency: 'Валюта',
  vat_rate: 'Ставка НДС',
  amount_includes_vat: 'Хранение суммы',
  bsm: 'БСМ',
  work_name: 'Наименование работ',
  work_start_date: 'Начало работ',
  work_end_date: 'Окончание работ',
  warranty_retention_percent: 'Гарантийное удержание',
  warranty_retention_period: 'Срок гарантийных удержаний',
  warranty_period: 'Срок гарантии на работы',
}

// ── Дерево документов ───────────────────────────────────────────────────────

// Из плоского списка (реестр грузит все договоры одним запросом) строим индексы.
// Никаких запросов на строку — иначе реестр из сотен договоров начнёт тормозить.
export function buildDocIndex(rows = []) {
  const byId = new Map()
  const byDisplayId = new Map()
  const childrenOf = new Map()

  for (const row of rows) {
    byId.set(row.id, row)
    byDisplayId.set(Number(row.display_id), row)
  }
  for (const row of rows) {
    if (!row.parent_contract_id) continue
    if (!childrenOf.has(row.parent_contract_id)) childrenOf.set(row.parent_contract_id, [])
    childrenOf.get(row.parent_contract_id).push(row)
  }
  // Порядок детей — по ID документа: он же порядок появления.
  for (const list of childrenOf.values()) {
    list.sort((a, b) => Number(a.display_id) - Number(b.display_id))
  }

  return { byId, byDisplayId, childrenOf }
}

export const liveChildren = (doc, index) =>
  (index.childrenOf.get(doc?.id) || []).filter(isLive)

// Прямые изменения документа (в живой ветке оно максимум одно — гарантирует триггер).
export const liveChanges = (doc, index) =>
  liveChildren(doc, index).filter(c => c.record_type === DOC_TYPE.CHANGE)

// Ветки дополнительных работ договора.
export const liveExtraBranches = (contract, index) =>
  liveChildren(contract, index).filter(c => c.record_type === DOC_TYPE.EXTRA)

// Вершина ветки: спускаемся по цепочке изменений до последнего документа.
// К ней и крепится следующее изменение.
export function branchTip(doc, index) {
  let current = doc
  const seen = new Set()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)                       // страховка от цикла в данных
    const next = liveChanges(current, index)[0]
    if (!next) return current
    current = next
  }
  return current
}

// Цепочка ветки от её основания до вершины: [основание, изменение1, изменение2…].
export function branchChain(base, index) {
  const chain = []
  let current = base
  const seen = new Set()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    chain.push(current)
    current = liveChanges(current, index)[0]
  }
  return chain
}

// Все документы дерева договора, сверху вниз (для реестра ДС и карточки).
export function flattenTree(root, index) {
  const out = []
  const walk = (doc, depth) => {
    for (const child of liveChildren(doc, index)) {
      out.push({ doc: child, depth })
      walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

// ── Актуальные значения ─────────────────────────────────────────────────────

// Значения ветки с учётом ЗАВЕРШЁННЫХ изменений: идём от основания к вершине и
// накладываем только те поля, которые документ действительно менял.
//
// options.stopAt — id документа, на котором обход прекращается. Нужен при
// РЕДАКТИРОВАНИИ ДС: там основание — родитель редактируемого документа, и без
// остановки в снимок «унаследованного» попали бы изменения самого этого ДС,
// после чего список изменяемых полей обнулился бы.
export function effectiveValues(base, index, options = {}) {
  const { stopAt = null } = options
  const result = { ...base }
  for (const doc of branchChain(base, index)) {
    if (doc.id === base.id) continue
    if (stopAt && doc.id === stopAt) break
    if (!isCompleted(doc)) break            // незавершённое изменение ни на что не влияет
    for (const field of doc.changed_fields || []) {
      if (!OVERRIDABLE_FIELDS.includes(field)) continue
      result[field] = doc[field]
    }
  }
  return result
}

// Стоимость ветки = сумма её последнего завершённого состояния. Изменяющее ДС
// заменяет стоимость ветки, а не добавляется к ней.
export function branchAmount(base, index) {
  const eff = effectiveValues(base, index)
  const value = Number(eff.contract_amount)
  return Number.isFinite(value) ? value : 0
}

// Актуальная сумма договора: основная ветка + каждая ЗАВЕРШЁННАЯ ветка
// дополнительных работ. Незавершённые доп. работы в сумму не входят.
export function contractActualAmount(contract, index) {
  let total = branchAmount(contract, index)
  for (const extra of liveExtraBranches(contract, index)) {
    if (!isCompleted(extra)) continue
    total += branchAmount(extra, index)
  }
  return total
}

// Исходная сумма договора — то, что записано в самом договоре, без изменений.
export function contractOriginalAmount(contract) {
  const value = Number(contract?.contract_amount)
  return Number.isFinite(value) ? value : 0
}

// ── Правила создания (те же, что в триггерах; здесь — для подсказок в UI) ────

// Что мешает создать изменяющее ДС к этой ветке. null — можно создавать.
export function blockingChange(base, index) {
  const tip = branchTip(base, index)
  if (tip.id !== base.id && !isCompleted(tip)) return tip
  if (isAmendment(tip) && tip.record_type === DOC_TYPE.CHANGE && !isCompleted(tip)) return tip
  return null
}

// Родитель для нового изменяющего ДС: вершина ветки указанного документа.
export function parentForChange(base, index) {
  return branchTip(base, index)
}

// Можно ли создать документ данного типа и к какому родителю.
// Возвращает { ok, parent, reason }.
export function planAmendment(type, target, index) {
  if (!target) return { ok: false, parent: null, reason: 'Не выбран документ' }

  if (type === DOC_TYPE.EXTRA) {
    const root = target.record_type === DOC_TYPE.CONTRACT ? target : index.byId.get(target.root_contract_id)
    if (!root) return { ok: false, parent: null, reason: 'Не найден основной договор' }
    return { ok: true, parent: root, reason: null }
  }

  if (type === DOC_TYPE.CHANGE) {
    const parent = parentForChange(target, index)
    const blocker = blockingChange(target, index)
    if (blocker) {
      return {
        ok: false,
        parent: null,
        reason: `ДС ID ${blocker.display_id} ещё не завершено. В одной ветке допускается только одно незавершённое изменение`,
      }
    }
    return { ok: true, parent, reason: null }
  }

  return { ok: false, parent: null, reason: 'Неизвестный тип документа' }
}

// Какие поля ДС реально меняет: сравниваем заполненную форму с унаследованным
// снимком. Пользователю changed_fields не показываем — он видит подсветку.
export function collectChangedFields(inherited, form) {
  const changed = []
  for (const field of OVERRIDABLE_FIELDS) {
    const before = normalizeForCompare(inherited?.[field])
    const after = normalizeForCompare(form?.[field])
    if (before !== after) changed.push(field)
  }
  return changed
}

function normalizeForCompare(value) {
  if (value == null || value === '') return ''
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') return String(value)
  return String(value).trim()
}
