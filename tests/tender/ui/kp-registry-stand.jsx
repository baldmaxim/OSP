// Реестр расценок → «Расценки от подрядчиков (КП)» (миграция 20261122) — отдельно от остальных стендов: страница
// реестра со своими данными. «Представление» kp_rates_registry стенда — таблица в памяти; ручные расценки
// (kp_manual_rates) попадают в него сразу, как в базе (живое объединение), — триггером «после записи» стенда.
//   ?kpRegistryLegacy=1 — колонок источника ещё нет (база раньше миграции): выборка с ними отвечает 42703.
//   ?canEdit=0 — без права правки реестра.
// kp_rates_lookup — похожие расценки: строки реестра, у которых есть общее слово с наименованием (окончательную
// похожесть считает страница).
import RatesRegistryPage from '../../../src/pages/RatesRegistryPage'

const params = new URLSearchParams(window.location.search)
const fdb = window.__fakeDb
const OBJ = { id: 'kr-obj-1', name: 'ЖК Стендовый' }
const TENDER = { id: 'kr-t1', work_description: 'Электромонтаж корпуса 1', object_id: OBJ.id, public_tender_number: 512, tender_type: 'main', deleted_at: null }
const CPS = [{ id: 'kr-cp-1', name: 'ООО Стенд-Электро' }, { id: 'kr-cp-2', name: 'ООО Кабельщик' }]

const base = { tender_id: TENDER.id, tender_desc: TENDER.work_description, object_id: OBJ.id, object_name: OBJ.name, proposal_date: '2026-10-01',
  source_url: null, manual_id: null, note: null, estimate_name: null, source_doc_id: null, source_doc_name: null }
const kpRow = (id, cp, item_type, item_name, unit, price, extra = {}) => ({
  ...base, id, item_type, item_name, unit, price, counterparty_id: cp.id, counterparty_name: cp.name, source_kind: 'kp', ...extra,
})

fdb.kp_rates_registry = [
  kpRow('kr-1', CPS[0], 'material', 'Кабель ВВГнг(А)-LS 3х2,5', 'м', 120, { estimate_name: 'ВОР ЭОМ', source_doc_id: 'kr-doc-1', source_doc_name: 'КП Стенд-Электро.xlsx' }),
  kpRow('kr-2', CPS[1], 'material', 'Кабель ВВГнг(А)-LS 3х2,5', 'м', 100, { estimate_name: 'ВОР ЭОМ' }),
  kpRow('kr-3', CPS[1], 'material', 'Лоток перфорированный 100х50', 'м', 450, { source_kind: 'site', proposal_date: '2026-10-20' }),
  kpRow('kr-4', CPS[0], 'work', 'Прокладка кабеля в лотке', 'м', 45, { estimate_name: 'ВОР ЭОМ', source_doc_id: 'kr-doc-1', source_doc_name: 'КП Стенд-Электро.xlsx' }),
]
fdb.kp_manual_rates = []
fdb.s3_documents.push({ id: 'kr-doc-1', owner_type: 'tender', owner_id: TENDER.id, s3_key: 'tenders/kr-t1/kp.pdf', file_name: 'КП Стенд-Электро.xlsx',
  mime_type: 'application/pdf', size_bytes: 2048, created_at: '2026-10-01T10:00:04Z', uploaded_by_name: 'Инженер' })
window.__fakeFiles = { ...(window.__fakeFiles || {}), 'tenders/kr-t1/kp.pdf': 'data:application/pdf;base64,JVBERi0xLjQK' }
fdb.counterparties.push(...CPS)
fdb.objects = [...(fdb.objects || []), OBJ]
fdb.tenders.push(TENDER)
fdb.kp_rates_registry_filter_objects = [{ object_id: OBJ.id, object_name: OBJ.name }]
fdb.kp_rates_registry_filter_counterparties = CPS.map((c) => ({ counterparty_id: c.id, counterparty_name: c.name }))
fdb.kp_rates_registry_filter_tenders = [{ tender_id: TENDER.id, tender_desc: TENDER.work_description, object_id: OBJ.id }]
fdb.app_settings = [...(fdb.app_settings || []).filter((s) => s.key !== 'rates_registry_refreshed_at'),
  { key: 'rates_registry_refreshed_at', value: '2026-10-30T09:00:00Z' }]

// Ручная строка → строка «представления», как в базе: подрядчик, объект (свой или тендера), документ.
const viewRow = (m) => {
  const t = fdb.tenders.find((x) => x.id === m.tender_id)
  const objectId = m.object_id || t?.object_id || null
  const doc = m.s3_document_id ? fdb.s3_documents.find((d) => d.id === m.s3_document_id) : null
  return {
    id: `manual-${m.id}`, item_type: m.item_type, item_name: m.item_name, unit: m.unit, price: m.price, tender_id: m.tender_id,
    counterparty_id: m.counterparty_id, object_id: objectId, tender_desc: t?.work_description || null,
    object_name: fdb.objects.find((o) => o.id === objectId)?.name || null,
    counterparty_name: fdb.counterparties.find((c) => c.id === m.counterparty_id)?.name || null, proposal_date: m.rate_date,
    source_kind: 'manual', estimate_name: null, source_doc_id: m.s3_document_id || null, source_doc_name: doc?.file_name || null,
    source_url: m.doc_url || null, manual_id: m.id, note: m.note || null,
  }
}
const syncManual = () => {
  fdb.kp_rates_registry = [...fdb.kp_rates_registry.filter((r) => r.source_kind !== 'manual'), ...fdb.kp_manual_rates.map(viewRow)]
  window.__fakeTouch('kp_rates_registry')
}
window.__fakeTriggers = { ...(window.__fakeTriggers || {}), kp_manual_rates: (row) => { row.created_by_name ??= 'Инженер Стендов' } }
window.__fakeAfter = { ...(window.__fakeAfter || {}), kp_manual_rates: () => syncManual(), s3_documents: () => syncManual() }
fdb.kp_manual_rates.push({ id: 'kr-m1', item_type: 'material', item_name: 'Лоток перфорированный 100х50', unit: 'м', price: 430,
  counterparty_id: CPS[0].id, object_id: null, tender_id: TENDER.id, rate_date: '2026-10-25', doc_url: 'https://disk.example.invalid/kp-lotok.pdf',
  s3_document_id: null, note: 'Цена с доставкой до объекта', created_by_name: 'Инженер Стендов' })
syncManual()

const words = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 4)
window.__lookupCalls = []
window.__fakeRpc = {
  ...(window.__fakeRpc || {}),
  kp_rates_lookup({ p_names, p_kind }) {
    window.__lookupCalls.push({ names: p_names, kind: p_kind })
    const out = []
    p_names.forEach((name, i) => {
      const w = new Set(words(name))
      for (const r of fdb.kp_rates_registry) {
        if (p_kind && r.item_type !== p_kind) continue
        if (!words(r.item_name).some((x) => w.has(x))) continue
        out.push({ ...r, idx: i + 1, sim: 0.5 })
      }
    })
    return { data: JSON.parse(JSON.stringify(out)), error: null }
  },
}

if (params.get('kpRegistryLegacy') === '1') {
  window.__fakeMissingColumns = { ...(window.__fakeMissingColumns || {}),
    kp_rates_registry: ['source_kind', 'estimate_name', 'source_doc_id', 'source_doc_name', 'source_url', 'manual_id', 'note'] }
}

export default function KpRegistryStand() {
  return <div style={{ padding: '1rem' }}><RatesRegistryPage /></div>
}
