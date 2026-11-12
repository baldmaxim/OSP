// Стенд «Сметы КП / ПЗ» вкладки «Смета» карточки объекта (route=/stand/kp-estimate). Данные — здесь, другим стендам не мешают.
// Триггеры базы (миграция 20270215) повторены подделками: смета и объект — от строки, версия строки +1, кто изменил,
// правка только у действующей сметы, история (kp_estimate_log) с «было / стало», загрузка версии с переносом отметок по
// ключу строки. Книги — tests/tender/lib/kpEstimateSample.mjs (вымышленные позиции в раскладке файлов К14).
//   kpe=empty   — смета объекта ещё не загружена;
//   kpe=missing — базы без миграции (таблиц нет);
//   noEdit=kp_estimate — без права правки сметы (только просмотр).
// window.__kpeColleague(rowNo, patch, name) — правка коллеги: отметка строки меняется в «базе» и попадает в историю.
// window.__kpeXLSX, window.__kpeSample — модуль xlsx и книги-образцы (тест собирает из них новую версию для загрузки).
import * as XLSXNs from 'xlsx'
import '../../../src/pages/ObjectDetailPage.css'
import KpEstimateWorkspace from '../../../src/components/kpEstimate/KpEstimateWorkspace'
import { buildEstimateRows, parseKpWorkbook, parsePzWorkbook } from '../../../src/utils/kpEstimateImport'
import { sampleKpWorkbook, samplePzWorkbook } from '../lib/kpEstimateSample.mjs'

const XLSX = XLSXNs.utils ? XLSXNs : XLSXNs.default
window.__kpeXLSX = XLSX
window.__kpeSample = { sampleKpWorkbook, samplePzWorkbook }
const params = new URLSearchParams(window.location.search)
const mode = params.get('kpe') || 'sample'
const OBJECT = 'obj-k1'
const me = params.get('asUser') || 'user-1'
const fdb = window.__fakeDb
let seq = 0
const id = (p) => `${p}-${++seq}`
const now = () => new Date().toISOString()

fdb.objects = [...(fdb.objects || []).filter((o) => o.id !== OBJECT), { id: OBJECT, name: 'ЖК Пример, корпус 1', status: 'main_construction' }]
fdb.kp_estimates = []
fdb.kp_estimate_rows = []
fdb.kp_estimate_marks = []
fdb.kp_estimate_allocations = []
fdb.kp_estimate_log = []
fdb.tenders = [...(fdb.tenders || []),
  { id: 'kt-501', object_id: OBJECT, public_tender_number: 501, parent_tender_id: null, work_description: 'Монолит надземной части', status: 'Завершен', deleted_at: null },
  { id: 'kt-502', object_id: OBJECT, public_tender_number: 502, parent_tender_id: null, work_description: 'Отделка полов паркинга', status: 'Идет тендерная процедура', deleted_at: null },
]
fdb.counterparties = [...(fdb.counterparties || []),
  { id: 'kc-1', name: 'ООО «Монолит-Строй»', inn: '7701000001', status: 'active', deleted_at: null },
  { id: 'kc-2', name: 'АО «Полы и кровли»', inn: '7701000002', status: 'active', deleted_at: null },
]
fdb.tender_winners = [...(fdb.tender_winners || []), { id: 'kw-1', tender_id: 'kt-501', counterparty_id: 'kc-1' }]
fdb.contracts = [...(fdb.contracts || []),
  { id: 'kk-1', object_id: OBJECT, counterparty_id: 'kc-1', contract_number: 'ПК-ДП-26-001', contract_date: '2026-10-20', record_type: 'dp', deleted_at: null, tender_id: 'kt-501', status: 'signed', display_id: 1, work_name: 'Монолит' },
]
fdb.employee_directory = [
  { user_id: 'user-1', display_name: 'Тест', full_name: 'Тест', email: 'test@example.invalid', role: 'admin' },
  { user_id: 'econ-1', display_name: 'Экономова Елена', full_name: 'Экономова Елена', email: 'e1@example.invalid', role: 'economist' },
  { user_id: 'econ-2', display_name: 'Сметов Сергей', full_name: 'Сметов Сергей', email: 'e2@example.invalid', role: 'economist' },
]
const nameOf = (uid) => fdb.employee_directory.find((e) => e.user_id === uid)?.full_name || 'Тест'

// ── Подделки триггеров ──────────────────────────────────────────────────────
const MARK_FIELDS = ['note', 'fill', 'cell_fills', 'actual_qty', 'actual_reason', 'responsible_id', 'responsible_name']
const ALLOC_FIELDS = ['tender_id', 'tender_label', 'pz_qty', 'counterparty_id', 'counterparty_name', 'contract_id', 'contract_label', 'contract_qty', 'note']
const rowOf = (rowId) => fdb.kp_estimate_rows.find((r) => r.id === rowId)
const estOf = (eid) => fdb.kp_estimates.find((e) => e.id === eid)
let transfer = false
const touch = (isAlloc) => (row, old) => {
  if (transfer) return
  const r = rowOf(row.row_id)
  if (!r) throw new Error('Строка сметы не найдена')
  if (estOf(r.estimate_id)?.status !== 'active') throw Object.assign(new Error('kp_estimate_not_active: смета заменена новой версией — правка закрыта'), { code: 'P0001' })
  row.estimate_id = r.estimate_id
  row.object_id = r.object_id
  row.updated_by = window.__kpeActor || me
  row.updated_by_name = nameOf(row.updated_by)
  row.row_version = old ? (old.row_version || 1) + 1 : 1
  if (!isAlloc) {
    row.cell_fills = row.cell_fills || {}
    for (const k of ['note', 'actual_reason', 'responsible_name']) row[k] = row[k] ? String(row[k]).trim() || null : null
  } else {
    row.pz_qty = Number(row.pz_qty) || 0
    row.contract_qty = Number(row.contract_qty) || 0
    if (!old) { row.created_by = row.updated_by; row.created_by_name = row.updated_by_name }
  }
}
window.__fakeTriggers = { ...(window.__fakeTriggers || {}), kp_estimate_marks: touch(false), kp_estimate_allocations: touch(true) }
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const logWrite = (entity, fields) => (op, row, old) => {
  if (transfer) return
  const any = row || old
  const changes = {}
  for (const k of fields) {
    const o = old?.[k] ?? null
    const n = row?.[k] ?? null
    if (!same(o, n) && !(k === 'cell_fills' && same(o || {}, n || {}))) changes[k] = { old: o, new: n }
  }
  if (!Object.keys(changes).length) return
  if (entity === 'allocation') changes._allocation = { id: any.id, tender: any.tender_label, counterparty: any.counterparty_name, contract: any.contract_label }
  const r = rowOf(any.row_id)
  fdb.kp_estimate_log.push({
    id: fdb.kp_estimate_log.length + 1, estimate_id: any.estimate_id, object_id: any.object_id, row_id: any.row_id,
    row_label: [r?.code || (r?.pos_no ? `№ ${r.pos_no}` : ''), r?.name].filter(Boolean).join(' '),
    entity, action: op, changes, changed_by: window.__kpeActor || me, changed_by_name: nameOf(window.__kpeActor || me), changed_at: now(),
  })
  window.__fakeTouch?.('kp_estimate_log')
}
window.__fakeAfter = { ...(window.__fakeAfter || {}), kp_estimate_marks: logWrite('mark', MARK_FIELDS), kp_estimate_allocations: logWrite('allocation', ALLOC_FIELDS) }
// Пара «тендер + подрядчик» у позиции одна (уникальный индекс базы).
const pairKey = (a) => `${a.tender_id || `l:${String(a.tender_label || '').toLowerCase().trim()}`}|${a.counterparty_id || `l:${String(a.counterparty_name || '').toLowerCase().trim()}`}`
window.__fakeGenerated = { ...(window.__fakeGenerated || {}), kp_estimate_allocations: (a) => ({ pair_key: pairKey(a) }) }
window.__fakeUnique = { ...(window.__fakeUnique || {}), kp_estimate_allocations: ['row_id', 'pair_key'] }

const activate = (estimateId) => {
  const est = estOf(estimateId)
  const rows = fdb.kp_estimate_rows.filter((r) => r.estimate_id === estimateId)
  if (rows.length !== est.row_count) return { data: null, error: { code: 'P0001', message: `kp_estimate_incomplete: загружено строк ${rows.length} из ${est.row_count}` } }
  const prev = fdb.kp_estimates.find((e) => e.object_id === est.object_id && e.status === 'active')
  transfer = true
  const result = { estimate_id: estimateId, previous_id: prev?.id || null, rows: rows.length, moved_marks: 0, moved_allocations: 0, moved_log: 0, left_marks: 0, left_allocations: 0 }
  if (prev) {
    prev.status = 'archived'
    const byKey = new Map(rows.map((r) => [r.row_key, r]))
    const oldRows = new Map(fdb.kp_estimate_rows.filter((r) => r.estimate_id === prev.id).map((r) => [r.id, r]))
    const move = (item, counter) => {
      const target = byKey.get(oldRows.get(item.row_id)?.row_key)
      if (!target) return
      item.row_id = target.id
      item.estimate_id = estimateId
      result[counter]++
    }
    for (const m of fdb.kp_estimate_marks.filter((x) => x.estimate_id === prev.id)) move(m, 'moved_marks')
    for (const a of fdb.kp_estimate_allocations.filter((x) => x.estimate_id === prev.id)) move(a, 'moved_allocations')
    for (const l of fdb.kp_estimate_log.filter((x) => x.estimate_id === prev.id && x.row_id)) move(l, 'moved_log')
    result.left_marks = fdb.kp_estimate_marks.filter((x) => x.estimate_id === prev.id).length
    result.left_allocations = fdb.kp_estimate_allocations.filter((x) => x.estimate_id === prev.id).length
  }
  est.status = 'active'
  est.activated_at = now()
  est.replaced_estimate_id = prev?.id || null
  est.transfer = result
  fdb.kp_estimate_log.push({ id: fdb.kp_estimate_log.length + 1, estimate_id: estimateId, object_id: est.object_id, row_id: null, row_label: null, entity: 'estimate', action: 'activate',
    changes: { ...result, title: est.title, kp_file: est.kp_file_name, pz_file: est.pz_file_name }, changed_by: me, changed_by_name: nameOf(me), changed_at: now() })
  transfer = false
  for (const t of ['kp_estimates', 'kp_estimate_marks', 'kp_estimate_allocations', 'kp_estimate_log']) window.__fakeTouch?.(t)
  return { data: result, error: null }
}
window.__fakeRpc = { ...(window.__fakeRpc || {}), kp_estimate_activate: ({ p_estimate }) => activate(p_estimate) }
window.__fakeTriggers.kp_estimates = (row, old) => {
  if (!old) { row.created_by = me; row.created_by_name = nameOf(me); row.created_at = row.created_at || now() }
}

if (mode === 'missing') {
  window.__fakeErrors = { ...(window.__fakeErrors || {}), kp_estimates: { code: 'PGRST205', message: "Could not find the table 'public.kp_estimates' in the schema cache" } }
}

// ── Действующая смета из книг-образцов ──────────────────────────────────────
if (mode === 'sample') {
  const kpWb = XLSX.read(XLSX.write(sampleKpWorkbook(XLSX), { type: 'array', bookType: 'xlsx' }), { type: 'array', cellFormula: true })
  const pzWb = XLSX.read(XLSX.write(samplePzWorkbook(XLSX), { type: 'array', bookType: 'xlsx' }), { type: 'array', cellFormula: true })
  const built = buildEstimateRows({ kp: parseKpWorkbook(XLSX, kpWb), pz: parsePzWorkbook(XLSX, pzWb), kpFileName: 'Пример К1 - КП до перекидок.xlsx', pzFileName: 'Смета.xlsx' })
  const est = { id: 'est-1', object_id: OBJECT, status: 'active', title: built.meta.title, kp_file_name: 'Пример К1 - КП до перекидок.xlsx', pz_file_name: 'Смета.xlsx',
    kp_s3_document_id: null, pz_s3_document_id: null, meta: built.meta, row_count: built.rows.length, replaced_estimate_id: null, transfer: null,
    created_by: 'econ-1', created_by_name: 'Экономова Елена', created_at: '2026-11-10T08:00:00Z', activated_at: '2026-11-10T08:00:00Z', updated_at: '2026-11-10T08:00:00Z' }
  fdb.kp_estimates.push(est)
  for (const r of built.rows) fdb.kp_estimate_rows.push({ ...r, id: `kr-${r.row_no}`, estimate_id: est.id, object_id: OBJECT })
  const row = (no) => `kr-${no}`
  // Отметки и распределения: стены — тендер 501 и договор (превышения нет), плиты — тендер и договоры больше актуального.
  fdb.kp_estimate_marks.push(
    { id: 'km-1', estimate_id: est.id, object_id: OBJECT, row_id: row(14), note: 'Объём по РД ревизии 3', fill: '#fff3bf', cell_fills: {}, actual_qty: null, actual_reason: null,
      responsible_id: 'econ-1', responsible_name: 'Экономова Елена', row_version: 1, updated_by: 'econ-1', updated_by_name: 'Экономова Елена', updated_at: '2026-11-11T09:00:00Z', created_at: '2026-11-11T09:00:00Z' },
    { id: 'km-2', estimate_id: est.id, object_id: OBJECT, row_id: row(15), note: null, fill: null, cell_fills: { actual: '#ffe3e3' }, actual_qty: 280, actual_reason: 'Пересчёт по РД: минус лоджии',
      responsible_id: 'econ-2', responsible_name: 'Сметов Сергей', row_version: 2, updated_by: 'econ-2', updated_by_name: 'Сметов Сергей', updated_at: '2026-11-11T10:00:00Z', created_at: '2026-11-11T10:00:00Z' },
  )
  const alloc = (aid, no, extra) => ({ id: aid, estimate_id: est.id, object_id: OBJECT, row_id: row(no), tender_id: null, tender_label: null, pz_qty: 0, counterparty_id: null,
    counterparty_name: null, contract_id: null, contract_label: null, contract_qty: 0, note: null, row_version: 1, created_by_name: 'Экономова Елена', created_at: '2026-11-11T09:00:00Z',
    updated_at: '2026-11-11T09:00:00Z', updated_by_name: 'Экономова Елена', ...extra })
  fdb.kp_estimate_allocations.push(
    alloc('ka-1', 14, { tender_id: 'kt-501', tender_label: '№ 501', pz_qty: 120, counterparty_id: 'kc-1', counterparty_name: 'ООО «Монолит-Строй»', contract_id: 'kk-1', contract_label: 'Договор № ПК-ДП-26-001 от 20.10.2026', contract_qty: 100 }),
    alloc('ka-2', 15, { tender_id: 'kt-501', tender_label: '№ 501', pz_qty: 300, counterparty_id: 'kc-1', counterparty_name: 'ООО «Монолит-Строй»', contract_qty: 300 }),
  )
  for (const a of fdb.kp_estimate_allocations) a.pair_key = pairKey(a)
}

// Правка коллеги прямо в «базе»: отметка строки и запись истории.
window.__kpeColleague = (rowNo, patch, uid = 'econ-2') => {
  const rowId = `kr-${rowNo}`
  const est = fdb.kp_estimates.find((e) => e.status === 'active')
  let m = fdb.kp_estimate_marks.find((x) => x.row_id === rowId)
  const old = m ? { ...m } : null
  if (!m) { m = { id: id('km'), estimate_id: est.id, object_id: OBJECT, row_id: rowId, cell_fills: {}, row_version: 0, created_at: now() }; fdb.kp_estimate_marks.push(m) }
  window.__kpeActor = uid
  Object.assign(m, patch, { updated_at: now() })
  touch(false)(m, old)
  logWrite('mark', MARK_FIELDS)(old ? 'update' : 'insert', m, old)
  window.__kpeActor = null
  window.__fakeTouch?.('kp_estimate_marks')
}

export default function KpEstimateStand() {
  return (
    <div className="object-detail-page" style={{ padding: '1rem' }}>
      <div className="tab-content estimate-content">
        <KpEstimateWorkspace objectId={OBJECT} objectName="ЖК Пример, корпус 1" />
      </div>
    </div>
  )
}
