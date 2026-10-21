// Договоры и ДС контрагента для вкладки «Общая информация» его карточки: плоский список документов
// (договоры и все их ДС) → группы «договор и его ДС». Правила дерева и сумм — utils/contractAmendments.
import {
  DOC_TYPE, DOC_TYPE_LABEL, buildDocIndex, contractActualAmount, effectiveDocumentAmount, flattenTree,
} from './contractAmendments.js'

const fmtDate = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString('ru-RU') : '')

// Подпись документа: вид, номер, дата.
export function docTitle(doc) {
  const kind = doc.record_type === DOC_TYPE.CONTRACT ? 'Договор' : (DOC_TYPE_LABEL[doc.record_type] || 'ДС')
  const num = doc.contract_number ? `№ ${doc.contract_number}` : 'без номера'
  return { kind, num, date: fmtDate(doc.contract_date) }
}

// Группы: корень (договор; ДС, чей родитель не загружен, — тоже корень, чтобы не потерялось) и его ДС
// сверху вниз с глубиной. Свежие договоры — выше. actual — сумма договора с завершёнными ДС, только если
// она отличается от суммы самого договора.
export function groupCounterpartyDocs(docs) {
  const index = buildDocIndex(docs)
  const roots = docs
    .filter(d => !d.parent_contract_id || !index.byId.has(d.parent_contract_id))
    .sort((a, b) => String(b.contract_date || '').localeCompare(String(a.contract_date || ''))
      || Number(b.display_id) - Number(a.display_id))
  return roots.map(root => {
    const original = effectiveDocumentAmount(root)
    const actual = root.record_type === DOC_TYPE.CONTRACT ? contractActualAmount(root, index) : null
    return {
      root,
      children: flattenTree(root, index),
      actual: actual != null && original != null && Math.abs(actual - original) >= 0.005 ? actual : null,
    }
  })
}
