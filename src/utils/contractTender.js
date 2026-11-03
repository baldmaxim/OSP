// Тендер договора и ДС (contracts.tender_id). ДС берёт тендер своего договора; своё значение у него бывает, только если
// соглашение выросло из другого тендера. Поэтому смена тендера в договоре сразу видна у всех его ДС.
// byId — документы реестра по id (buildDocIndex). Ответ — null, если тендера нет ни у документа, ни у договора.
export function docTender(doc, byId) {
  for (let cur = doc, depth = 0; cur && depth < 50; depth++) {
    if (cur.tender_id) {
      return {
        id: cur.tender_id,
        number: cur.tenders?.public_tender_number ?? null,
        description: cur.tenders?.work_description || '',
        inherited: cur !== doc,
      }
    }
    const up = cur.parent_contract_id || (cur.root_contract_id && cur.root_contract_id !== cur.id ? cur.root_contract_id : null)
    cur = up ? byId.get(up) : null
  }
  return null
}

export const tenderTitle = (tender) => (tender.number != null ? `Тендер № ${tender.number}` : 'Тендер')

// Подпись в выборе тендера: номер важнее описания — описания у соседних тендеров похожи. Описание длинное — обрезаем.
export function tenderOptionLabel(tender) {
  const number = tender.public_tender_number != null ? `№ ${tender.public_tender_number}` : 'без номера'
  const text = (tender.work_description || '').trim()
  return `${number} · ${text.length > 140 ? `${text.slice(0, 139)}…` : text || 'описания нет'}`
}

// Выбор тендера в форме договора: основные тендеры объекта. Тендеры на материалы — копии основных с тем же описанием (их
// столько же, сколько основных), в списке только мешали; уже выбранный показываем любой, чтобы не потерять при сохранении.
export function tenderChoices(tenders, { objectId, selectedId }) {
  return tenders.filter(t => t.id === selectedId
    || (!t.parent_tender_id && !t.deleted_at && (!objectId || t.object_id === objectId)))
}
