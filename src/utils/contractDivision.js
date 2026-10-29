// Подразделение договора в реестре «Договоры и ДС» (contracts.division, миграция 20261112, обе базы) —
// те же коды и подписи, что подразделение ВОР у тендеров (utils/vorDivisions.js): плашка под «Работами»
// (VorDivisionChip subject='contract') и фильтр в заголовке колонки (VorDivisionFilter).
//
// Ставится у договора (ДП). ДС своего подразделения не имеют — показывают подразделение договора, к которому
// относятся (root_contract_id, без него — вверх по родителям): правка в строке договора видна у всех его ДС.
import { DOC_TYPE } from './contractAmendments.js'

export const CONTRACT_DIVISION_MIGRATION_HINT =
  'Подразделение договора недоступно: в базе не применена миграция 20261112_contracts_division.'

// Колонка есть, если её вернула выборка select('*') хотя бы у одного документа.
export const contractDivisionEnabled = (docs) => (docs || []).some(d => d && 'division' in d)

const isContract = (doc) => (doc?.record_type || DOC_TYPE.CONTRACT) === DOC_TYPE.CONTRACT

// Договор документа: сам договор, у ДС — его договор (null, если договор не загружен).
export function divisionOwner(doc, byId) {
  if (!doc) return null
  if (isContract(doc)) return doc
  let root = doc.root_contract_id && doc.root_contract_id !== doc.id ? byId.get(doc.root_contract_id) : null
  if (!root) {
    let cur = doc
    for (let i = 0; i < 50 && cur?.parent_contract_id; i++) cur = byId.get(cur.parent_contract_id)
    root = cur && cur !== doc ? cur : null
  }
  return root && isContract(root) ? root : null
}

// Код подразделения документа (или null): у ДС — подразделение его договора.
export function contractDivisionOf(doc, byId) {
  const owner = divisionOwner(doc, byId)
  return owner ? (owner.division ?? null) : (doc?.division ?? null)
}

// Текст отказа при смене подразделения: колонки ещё нет — называем миграцию, а не сырой ответ PostgREST.
export function contractDivisionSaveError(err) {
  const msg = String(err?.message || err || '')
  if ((err?.code === 'PGRST204' || err?.code === '42703') && /division/.test(msg)) return CONTRACT_DIVISION_MIGRATION_HINT
  return 'Ошибка: ' + msg
}
