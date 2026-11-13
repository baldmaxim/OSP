// Смета КП / ПЗ объекта — совместная работа экономистов с одним загруженным документом (вкладка «Смета» карточки
// объекта, миграция 20270215). 13.11.2026 упрощено по просьбе пользователя: одна таблица (КП до перекидок и план затрат
// вместе, без переключателя и переходов КП ↔ ПЗ), объём — только «Количество (ГП)», без ответственного; строка
// открывается окном — там тендер (может не быть) и подрядчик-победитель с объёмом; «Показать» вместо фильтров и
// плиток; «во весь экран» — значок справа сверху. Всё сохраняется само; правки коллег приходят по истории (раз в 10 с,
// пока вкладка открыта). Правила — utils/kpEstimate.js, запросы — services/kpEstimate.js.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { saveAs } from 'file-saver'
import { useRole } from '../../contexts/RoleContext'
import { downloadS3File } from '../FileDownload'
import {
  FILL_COLORS, SHOW_OPTIONS, ancestorsOf, buildTree, collapseToLevel, computeStates, descendantsOf, fmtMoneyShort, isPosition,
  markPayload, planTenderAllocation, rowHaystack, rowMatchesShow, searchTokens, showActive, visibleRowIds,
} from '../../utils/kpEstimate'
import { mergeNote } from '../../utils/dcRequestNotes'
import {
  deleteAllocation, deleteEstimate, fetchMark, insertAllocations, loadAllocations, loadEstimateInfo, loadLatestLogId, loadLog,
  loadLogSince, loadMarks, loadPickers, loadRows, loadSourceFiles, reloadForRows, saveMark, updateAllocation,
} from '../../services/kpEstimate'
import { COLUMNS, FILLABLE } from './columns'
import KpEstimateTable from './KpEstimateTable'
import KpEstimateRowDialog from './KpEstimateRowDialog'
import KpEstimateImportDialog from './KpEstimateImportDialog'
import { HistoryDialog, PassportDialog, TenderBulkDialog } from './KpEstimateDialogs'
import './KpEstimate.css'

const POLL_MS = 10_000

const groupAllocs = (list) => {
  const m = new Map()
  for (const a of list || []) {
    if (!m.has(a.row_id)) m.set(a.row_id, [])
    m.get(a.row_id).push(a)
  }
  return m
}
const errText = (e) => {
  const msg = String(e?.message || e || '')
  if (/kp_estimate_not_active/.test(msg)) return 'Смета заменена новой версией — правка закрыта. Обновите страницу.'
  if (/kp_estimate_allocations_pair|duplicate key/.test(msg)) return 'Этот тендер с этим подрядчиком у позиции уже есть — поправьте объём в его строке.'
  if (e?.code === '42501' || /row-level security|permission/i.test(msg)) return 'Нет права менять смету (раздел «Объекты: смета КП/ПЗ»).'
  return msg || 'Не удалось сохранить'
}

const ExpandIcon = ({ on }) => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {on
      ? <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
      : <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />}
  </svg>
)

export default function KpEstimateWorkspace({ objectId, objectName = '' }) {
  const { canEdit, isAdmin, isSuperAdmin, user } = useRole()
  const editRight = canEdit('kp_estimate')
  const myId = user?.id || null

  const [info, setInfo] = useState({ loading: true, estimate: null, versions: [], missing: false, error: '' })
  const [viewEstimateId, setViewEstimateId] = useState(null)
  const [rows, setRows] = useState(null)
  const [marks, setMarks] = useState(() => new Map())
  const [allocsByRow, setAllocsByRow] = useState(() => new Map())
  const [loadError, setLoadError] = useState('')
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [show, setShow] = useState('all')
  const [selection, setSelection] = useState(() => new Set())
  const anchorRef = useRef(null)
  const [cellSel, setCellSel] = useState(null)
  const [brush, setBrush] = useState(false)
  const [activeId, setActiveId] = useState(null)
  const [highlight, setHighlight] = useState(() => new Set())
  const [scrollTo, setScrollTo] = useState(null)
  const [remoteIds, setRemoteIds] = useState(() => new Set())
  const [notice, setNotice] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [pickers, setPickers] = useState(null)
  const [saveState, setSaveState] = useState({ pending: 0, errors: 0, message: '' })
  const [logVersion, setLogVersion] = useState(0)
  const [newVersion, setNewVersion] = useState(null)
  const [sourceFiles, setSourceFiles] = useState([])
  const [transferNote, setTransferNote] = useState(null)
  const [exporting, setExporting] = useState(false)

  const shown = useMemo(() => {
    if (viewEstimateId) return info.versions.find((v) => v.id === viewEstimateId) || null
    return info.estimate
  }, [info, viewEstimateId])
  const estimateId = shown?.id || null
  const writable = editRight && shown?.status === 'active'

  // ── Загрузка ────────────────────────────────────────────────────────────
  const loadInfo = useCallback(async () => {
    try {
      const res = await loadEstimateInfo(objectId)
      setInfo({ loading: false, ...res, error: '' })
      return res
    } catch (e) {
      setInfo({ loading: false, estimate: null, versions: [], missing: false, error: e.message || String(e) })
      return null
    }
  }, [objectId])
  useEffect(() => { loadInfo() }, [loadInfo])

  const serverMarks = useRef(new Map())
  const pending = useRef(new Map())
  const inflight = useRef(new Set())
  const timers = useRef(new Map())
  const failed = useRef(new Set())
  const lastLogId = useRef(0)

  useEffect(() => {
    let alive = true
    setRows(null)
    setLoadError('')
    setSelection(new Set())
    setCellSel(null)
    setActiveId(null)
    if (!estimateId) return undefined
    ;(async () => {
      try {
        const [r, m, a, logId, files] = await Promise.all([
          loadRows(estimateId), loadMarks(estimateId), loadAllocations(estimateId), loadLatestLogId(estimateId).catch(() => 0),
          loadSourceFiles([...new Set([shown.kp_s3_document_id, shown.pz_s3_document_id])]).catch(() => []),
        ])
        if (!alive) return
        lastLogId.current = logId
        serverMarks.current = new Map(m.map((x) => [x.row_id, x]))
        pending.current = new Map()
        setMarks(new Map(m.map((x) => [x.row_id, x])))
        setAllocsByRow(groupAllocs(a))
        setSourceFiles(files)
        setRows(r)
      } catch (e) {
        if (alive) setLoadError(e.message || String(e))
      }
    })()
    return () => { alive = false }
  }, [estimateId]) // eslint-disable-line react-hooks/exhaustive-deps

  const tree = useMemo(() => (rows ? buildTree(rows) : null), [rows])
  useEffect(() => { if (tree) setCollapsed(collapseToLevel(tree, 2)) }, [tree])
  const computed = useMemo(() => (tree ? computeStates(tree, marks, allocsByRow) : null), [tree, marks, allocsByRow])

  // ── Поиск и «Показать» ──────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setSearch(query), 200)
    return () => clearTimeout(t)
  }, [query])
  const match = useMemo(() => {
    if (!tree || !computed) return null
    const tokens = searchTokens(search)
    const on = showActive(show)
    if (!tokens.length && !on) return null
    const out = new Set()
    for (const r of tree.rows) {
      const mark = marks.get(r.id)
      if (on && !rowMatchesShow(r, mark, computed.states.get(r.id), show)) continue
      if (tokens.length) {
        const hay = rowHaystack(r, mark, allocsByRow.get(r.id))
        if (!tokens.every((t) => hay.includes(t))) continue
      }
      out.add(r.id)
    }
    return out
  }, [tree, computed, marks, allocsByRow, search, show])
  const ids = useMemo(() => (tree ? visibleRowIds(tree, { match, collapsed }) : []), [tree, match, collapsed])
  useEffect(() => { setCellSel(null) }, [ids])

  // ── Сохранение отметок ──────────────────────────────────────────────────
  const syncSaveState = useCallback((message) => {
    setSaveState((s) => ({
      pending: pending.current.size + inflight.current.size,
      errors: failed.current.size,
      message: message !== undefined ? message : (failed.current.size ? s.message : ''),
    }))
  }, [])

  const flushRef = useRef(null)
  const schedule = useCallback((rowId, delay) => {
    const t = timers.current.get(rowId)
    if (t) clearTimeout(t)
    timers.current.set(rowId, setTimeout(() => { timers.current.delete(rowId); flushRef.current(rowId) }, delay))
  }, [])

  const flush = useCallback(async (rowId) => {
    if (inflight.current.has(rowId)) return
    const patch = pending.current.get(rowId)
    if (!patch) return
    pending.current.delete(rowId)
    inflight.current.add(rowId)
    syncSaveState()
    let server = serverMarks.current.get(rowId) || null
    const toSend = { ...patch }
    try {
      let res
      for (let attempt = 0; ; attempt++) {
        res = await saveMark({ estimateId, objectId, rowId, mark: server, patch: toSend })
        if (!res.conflict) break
        if (attempt >= 2) throw new Error('Позицию одновременно меняют несколько человек — повторите правку')
        // Коллега успел раньше: его текст примечания и причины не теряется — своё дописывается к нему.
        const fresh = await fetchMark(rowId)
        if ('note' in toSend) toSend.note = mergeNote(server?.note ?? null, toSend.note, fresh?.note ?? null)
        if ('actual_reason' in toSend) toSend.actual_reason = mergeNote(server?.actual_reason ?? null, toSend.actual_reason, fresh?.actual_reason ?? null)
        server = fresh
        setNotice({ kind: 'info', text: `${fresh?.updated_by_name || 'Коллега'} одновременно правил эту позицию: его изменения сохранены, ваши — поверх (всё видно в истории).` })
      }
      serverMarks.current.set(rowId, res.mark)
      failed.current.delete(rowId)
      setMarks((prev) => {
        const next = new Map(prev)
        next.set(rowId, { ...res.mark, ...(pending.current.get(rowId) || {}) })
        return next
      })
      setLogVersion((v) => v + 1)
      syncSaveState('')
    } catch (e) {
      pending.current.set(rowId, { ...patch, ...(pending.current.get(rowId) || {}) })
      failed.current.add(rowId)
      syncSaveState(errText(e))
    } finally {
      inflight.current.delete(rowId)
      if (pending.current.has(rowId) && !failed.current.has(rowId)) schedule(rowId, 0)
      syncSaveState()
    }
  }, [estimateId, objectId, schedule, syncSaveState])
  flushRef.current = flush

  const editMark = useCallback((rowId, patch, delay = 0) => {
    if (!writable) return
    const clean = markPayload(patch)
    if (!Object.keys(clean).length) return
    setMarks((prev) => {
      const next = new Map(prev)
      next.set(rowId, { row_id: rowId, cell_fills: {}, ...(prev.get(rowId) || {}), ...clean })
      return next
    })
    pending.current.set(rowId, { ...(pending.current.get(rowId) || {}), ...clean })
    failed.current.delete(rowId)
    syncSaveState()
    schedule(rowId, delay)
  }, [writable, schedule, syncSaveState])

  const retryFailed = () => {
    for (const id of [...failed.current]) { failed.current.delete(id); schedule(id, 0) }
    syncSaveState('')
  }

  // Закрыли вкладку с несохранённым — браузер спросит.
  useEffect(() => {
    const onBefore = (e) => { if (pending.current.size || inflight.current.size) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  }, [])

  // ── Распределения ───────────────────────────────────────────────────────
  const putAllocs = useCallback((list, removeIds = []) => {
    setAllocsByRow((prev) => {
      const next = new Map(prev)
      const touched = new Set([...list.map((a) => a.row_id)])
      for (const id of removeIds) for (const [rowId, arr] of next) if (arr.some((a) => a.id === id)) touched.add(rowId)
      for (const rowId of touched) {
        let arr = (next.get(rowId) || []).filter((a) => !removeIds.includes(a.id))
        for (const a of list.filter((x) => x.row_id === rowId)) {
          const i = arr.findIndex((x) => x.id === a.id)
          if (i >= 0) arr[i] = a; else arr = [...arr, a]
        }
        if (arr.length) next.set(rowId, arr); else next.delete(rowId)
      }
      return next
    })
    setLogVersion((v) => v + 1)
  }, [])

  const onAllocInsert = useCallback(async (rowId, payload) => {
    try {
      const created = await insertAllocations(estimateId, objectId, [{ row_id: rowId, ...payload }])
      putAllocs(created)
      return true
    } catch (e) {
      setNotice({ kind: 'error', text: errText(e) })
      return false
    }
  }, [estimateId, objectId, putAllocs])
  const onAllocUpdate = useCallback(async (alloc, patch) => {
    try {
      const res = await updateAllocation(alloc, patch)
      if (res.conflict) {
        const fresh = await reloadForRows([alloc.row_id])
        setAllocsByRow((prev) => { const next = new Map(prev); next.set(alloc.row_id, fresh.allocs.filter((a) => a.row_id === alloc.row_id)); return next })
        setNotice({ kind: 'info', text: 'Это распределение только что изменил коллега — показано его значение, повторите правку.' })
        return
      }
      putAllocs([res.allocation])
    } catch (e) {
      setNotice({ kind: 'error', text: errText(e) })
    }
  }, [putAllocs])
  const onAllocDelete = useCallback(async (alloc) => {
    if (!window.confirm(`Удалить распределение «${[alloc.tender_label, alloc.counterparty_name].filter(Boolean).join(' · ')}»?`)) return
    try {
      await deleteAllocation(alloc.id)
      putAllocs([], [alloc.id])
    } catch (e) {
      setNotice({ kind: 'error', text: errText(e) })
    }
  }, [putAllocs])

  const ensurePickers = useCallback(() => {
    if (pickers || !writable) return
    setPickers({ loading: true, tenders: [], counterparties: [], winners: [] })
    loadPickers(objectId).then(setPickers).catch(() => setPickers({ tenders: [], counterparties: [], winners: [] }))
  }, [pickers, writable, objectId])

  // ── Правки коллег: по истории ───────────────────────────────────────────
  useEffect(() => {
    if (!estimateId || !rows || shown?.status !== 'active') return undefined
    let stop = false
    const tick = async () => {
      if (stop || document.visibilityState !== 'visible') return
      try {
        const entries = await loadLogSince(estimateId, lastLogId.current)
        if (!entries.length) return
        lastLogId.current = entries[entries.length - 1].id
        const foreign = entries.filter((e) => e.changed_by !== myId)
        const activation = foreign.find((e) => e.entity === 'estimate' && e.action === 'activate')
        if (activation) { setNewVersion(activation); return }
        const rowIds = [...new Set(foreign.map((e) => e.row_id).filter(Boolean))]
        if (!rowIds.length) return
        const fresh = await reloadForRows(rowIds)
        if (stop) return
        const busy = new Set([...pending.current.keys(), ...inflight.current])
        setMarks((prev) => {
          const next = new Map(prev)
          for (const id of rowIds) {
            const m = fresh.marks.find((x) => x.row_id === id)
            if (m) serverMarks.current.set(id, m); else serverMarks.current.delete(id)
            if (busy.has(id)) continue
            if (m) next.set(id, m); else next.delete(id)
          }
          return next
        })
        setAllocsByRow((prev) => {
          const next = new Map(prev)
          for (const id of rowIds) {
            const list = fresh.allocs.filter((a) => a.row_id === id)
            if (list.length) next.set(id, list); else next.delete(id)
          }
          return next
        })
        const who = [...new Set(foreign.map((e) => e.changed_by_name).filter(Boolean))].join(', ')
        setRemoteIds(new Set(rowIds))
        setNotice({ kind: 'remote', text: `Изменения коллег${who ? ` (${who})` : ''}: позиций — ${rowIds.length}. Строки подсвечены.` })
        setLogVersion((v) => v + 1)
        setTimeout(() => setRemoteIds(new Set()), 6000)
      } catch { /* сеть — в следующий раз */ }
    }
    const timer = setInterval(tick, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { stop = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [estimateId, rows, shown?.status, myId])

  // ── Выделение и заливка ─────────────────────────────────────────────────
  const onSelect = useCallback((id, { shift }) => {
    setSelection((prev) => {
      const next = new Set(prev)
      const withBranch = (x) => [x, ...(tree.children.has(x) ? descendantsOf(tree, x) : [])]
      const on = !prev.has(id)
      if (shift && anchorRef.current && ids.includes(anchorRef.current)) {
        const a = ids.indexOf(anchorRef.current)
        const b = ids.indexOf(id)
        for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) for (const y of withBranch(x)) next.add(y)
      } else {
        for (const y of withBranch(id)) { if (on) next.add(y); else next.delete(y) }
      }
      return next
    })
    anchorRef.current = id
  }, [tree, ids])
  const clearSelection = () => { setSelection(new Set()); setCellSel(null) }

  const applyFill = (color) => {
    if (!writable) return
    if (cellSel) {
      const keys = COLUMNS.slice(cellSel.c1, cellSel.c2 + 1).map((c) => c.key).filter((k) => FILLABLE.has(k))
      for (const id of ids.slice(cellSel.r1, cellSel.r2 + 1)) {
        const cf = { ...(marks.get(id)?.cell_fills || {}) }
        for (const k of keys) { if (color) cf[k] = color; else delete cf[k] }
        editMark(id, { cell_fills: cf })
      }
      return
    }
    for (const id of selection) {
      if (color) editMark(id, { fill: color })
      else editMark(id, { fill: null, cell_fills: {} })
    }
  }

  // ── Переход к строке (из истории, ↑ ↓ в окне строки) ────────────────────
  const goTo = useCallback((id) => {
    if (!tree?.byId.has(id)) return
    if (match && !match.has(id)) { setQuery(''); setSearch(''); setShow('all') }
    setCollapsed((prev) => {
      const next = new Set(prev)
      for (const a of ancestorsOf(tree, id)) next.delete(a)
      return next
    })
    setActiveId(id)
    setHighlight(new Set([id]))
    setScrollTo({ id, t: Date.now() })
    setTimeout(() => setHighlight(new Set()), 4000)
  }, [tree, match])
  const onPrevNext = useCallback((dir) => {
    const i = ids.indexOf(activeId)
    const next = ids[i + dir]
    if (next) { setActiveId(next); setScrollTo({ id: next, t: Date.now() }) }
  }, [ids, activeId])

  const toggle = useCallback((id) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  }), [])

  const onEditCell = useCallback((id, patch) => {
    if (patch.invalid) { setNotice({ kind: 'error', text: patch.invalid }); return }
    editMark(id, patch)
  }, [editMark])

  const loadRowLog = useCallback((rowId) => (estimateId ? loadLog(estimateId, { rowId, limit: 30 }) : Promise.resolve([])), [estimateId])

  // ── Выгрузка: выделенное, иначе найденное, иначе вся смета ──────────────
  const exportScope = selection.size ? 'selected' : (match ? 'found' : 'all')
  const exportTitle = exportScope === 'selected' ? `Выгрузить в Excel выделенные строки (${selection.size})`
    : exportScope === 'found' ? `Выгрузить в Excel найденное (${match.size})` : 'Выгрузить в Excel всю смету'
  const doExport = async () => {
    setExporting(true)
    try {
      const { exportRowIds, buildEstimateWorkbook } = await import('../../utils/kpEstimateExport')
      const picked = exportScope === 'selected' ? [...selection] : (exportScope === 'found' ? [...match] : null)
      const label = exportScope === 'selected' ? `выделенные строки (${selection.size})` : (exportScope === 'found' ? `найденные (${match.size})` : 'вся смета')
      const buf = await buildEstimateWorkbook({ tree, marks, allocsByRow, states: computed.states, sums: computed.sums, total: computed.total, meta: shown.meta, estimate: shown },
        { ids: exportRowIds(tree, picked), scopeLabel: label })
      const day = new Date().toLocaleDateString('ru-RU')
      const name = `Смета КП-ПЗ — ${(shown.title || objectName || 'объект').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)} — ${day}.xlsx`
      saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name)
    } catch (e) {
      setNotice({ kind: 'error', text: `Выгрузка не получилась: ${e.message || e}` })
    } finally {
      setExporting(false)
    }
  }

  const applyBulk = async (target) => {
    const plan = planTenderAllocation({ rowIds: [...selection], tree, states: computed.states, allocsByRow, target })
    const created = plan.inserts.length ? await insertAllocations(estimateId, objectId, plan.inserts) : []
    const updated = []
    for (const u of plan.updates) {
      const alloc = (allocsByRow.get(u.row_id) || []).find((a) => a.id === u.id)
      const res = await updateAllocation(alloc, { pz_qty: u.pz_qty, ...(Number(alloc?.contract_qty) ? { contract_qty: 0 } : {}) })
      if (res.allocation) updated.push(res.allocation)
    }
    putAllocs([...created, ...updated])
    setNotice({ kind: 'info', text: `Распределено позиций: ${created.length + updated.length}${plan.skipped.length ? `; без свободного остатка — ${plan.skipped.length}` : ''}.` })
  }

  // ── Escape: снять выделение, выйти из «во весь экран» (окна закрываются сами) ──
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || dialog || activeId) return
      if (cellSel || selection.size) { setCellSel(null); setSelection(new Set()); return }
      if (brush) { setBrush(false); return }
      if (fullscreen) setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, activeId, cellSel, selection, brush, fullscreen])

  // ── Отрисовка ───────────────────────────────────────────────────────────
  if (info.loading) return <section className="kpe-root kpe-root--empty"><p className="kpe-muted">Загрузка сметы КП / ПЗ…</p></section>
  if (info.missing) {
    return (
      <section className="kpe-root kpe-root--empty">
        <h3 className="kpe-h">Смета КП / ПЗ</h3>
        <p className="kpe-muted">Раздел появится после обновления базы (миграция 20270215: смета, отметки, распределения, история).</p>
      </section>
    )
  }
  const versions = info.versions.filter((v) => v.status !== 'draft')
  const total = computed?.total
  const share = total?.total ? Math.round((total.distributedMoney / total.total) * 1000) / 10 : 0

  return (
    <section className={`kpe-root${fullscreen ? ' is-fullscreen' : ''}`} aria-label="Смета КП / ПЗ">
      <header className="kpe-head">
        <div className="kpe-head-title">
          <h3 className="kpe-h">Смета КП / ПЗ{shown ? <span className="kpe-h-sub"> — {shown.title}</span> : null}</h3>
          {shown && (
            <p className="kpe-muted kpe-head-meta">
              {shown.status === 'archived' ? 'Прежняя версия' : 'Версия'} от {new Date(shown.activated_at || shown.created_at).toLocaleDateString('ru-RU')}
              {shown.created_by_name ? `, ${shown.created_by_name}` : ''}
              {sourceFiles.map((f) => (
                <button key={f.id} type="button" className="kpe-text-btn" title="Скачать исходный файл"
                  onClick={() => downloadS3File(f.s3_key, f.file_name).catch((e) => setNotice({ kind: 'error', text: e.message || String(e) }))}>
                  · {f.file_name}
                </button>
              ))}
              <button type="button" className="kpe-text-btn" onClick={() => setDialog('passport')}>· Паспорт и коэффициенты</button>
            </p>
          )}
        </div>
        <div className="kpe-head-actions">
          {versions.length > 1 && (
            <select className="kpe-field kpe-field--compact" value={viewEstimateId || ''} aria-label="Версия документа"
              onChange={(e) => setViewEstimateId(e.target.value || null)}>
              <option value="">Действующая версия</option>
              {versions.filter((v) => v.status === 'archived').map((v) => (
                <option key={v.id} value={v.id}>Прежняя от {new Date(v.activated_at || v.created_at).toLocaleDateString('ru-RU')} — {v.title}</option>
              ))}
            </select>
          )}
          {shown && <button type="button" className="kpe-btn" onClick={() => setDialog('history')}>История</button>}
          {shown && tree && <button type="button" className="kpe-btn" title={exportTitle} disabled={exporting} onClick={doExport}>{exporting ? 'Excel…' : 'Excel'}</button>}
          {editRight && !viewEstimateId && <button type="button" className="kpe-btn kpe-btn--primary" onClick={() => setDialog('import')}>{info.estimate ? 'Загрузить новую версию' : 'Загрузить смету'}</button>}
          {shown && (isAdmin || isSuperAdmin) && shown.status === 'archived' && (
            <button type="button" className="kpe-btn kpe-btn--danger-ghost" onClick={async () => {
              if (!window.confirm('Удалить прежнюю версию вместе с её отметками и историей?')) return
              try { await deleteEstimate(shown.id); setViewEstimateId(null); loadInfo() } catch (e) { setNotice({ kind: 'error', text: errText(e) }) }
            }}>Удалить версию</button>
          )}
          {tree && (
            <button type="button" className="kpe-icon-btn kpe-fs-btn" aria-pressed={fullscreen} onClick={() => setFullscreen((f) => !f)}
              aria-label={fullscreen ? 'Свернуть (Esc)' : 'Во весь экран'} title={fullscreen ? 'Свернуть (Esc)' : 'Во весь экран'}>
              <ExpandIcon on={fullscreen} />
            </button>
          )}
        </div>
      </header>

      {info.error && <div className="kpe-warn">Смета не загрузилась: {info.error}</div>}
      {loadError && <div className="kpe-warn">Строки сметы не загрузились: {loadError}</div>}
      {newVersion && (
        <div className="kpe-banner">
          {newVersion.changed_by_name || 'Коллега'} загрузил(а) новую версию документа.
          <button type="button" className="kpe-btn kpe-btn--primary" onClick={() => { setNewVersion(null); setViewEstimateId(null); loadInfo() }}>Открыть новую версию</button>
        </div>
      )}
      {shown?.status === 'archived' && (
        <div className="kpe-banner kpe-banner--muted">
          Прежняя версия — только просмотр. Здесь остались отметки и распределения позиций, которых нет в новом файле.
          <button type="button" className="kpe-btn" onClick={() => setViewEstimateId(null)}>К действующей версии</button>
        </div>
      )}
      {transferNote && (
        <div className="kpe-banner kpe-banner--ok">
          {transferNote}
          <button type="button" className="kpe-icon-btn" aria-label="Скрыть" onClick={() => setTransferNote(null)}>✕</button>
        </div>
      )}

      {!shown && (
        <div className="kpe-empty">
          <p><b>Смета КП / ПЗ не загружена.</b></p>
          <p className="kpe-muted">Один документ для всех экономистов объекта: КП до перекидок и план затрат. По каждой позиции — примечание, заливка, уточнённый объём и причина, тендер и подрядчик-победитель с объёмом, свободный остаток.</p>
          {!editRight && <p className="kpe-muted">Загружает экономист с правом «Объекты: смета КП/ПЗ».</p>}
        </div>
      )}

      {shown && !tree && !loadError && <p className="kpe-muted">Загрузка строк…</p>}

      {tree && computed && (
        <>
          <p className="kpe-summary" aria-label="Итоги">
            <span>Стоимость КП <b title={`${total.total.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽`}>{fmtMoneyShort(total.total)}</b></span>
            {total.direct ? <span>Прямые затраты <b title={`${total.direct.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} ₽`}>{fmtMoneyShort(total.direct)}</b></span> : null}
            <span>Распределено <b>{fmtMoneyShort(total.distributedMoney)}</b> ({share.toLocaleString('ru-RU')} %)</span>
            <span>Свободно <b>{fmtMoneyShort(total.freeMoney)}</b></span>
            {total.counts.over ? <button type="button" className="kpe-text-btn kpe-over" onClick={() => setShow('over')}>Превышение: {total.counts.over}</button> : null}
          </p>

          <div className="kpe-toolbar">
            <input type="search" className="kpe-field kpe-search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск: код, наименование, примечание, тендер, подрядчик" aria-label="Поиск по смете" />
            <select className={`kpe-field kpe-field--compact${showActive(show) ? ' is-on' : ''}`} value={show} aria-label="Показать" onChange={(e) => setShow(e.target.value)}>
              {SHOW_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.key === 'all' ? 'Показать: все строки' : `${o.label} (${o.count(total)})`}</option>)}
            </select>
            {match && <span className="kpe-muted kpe-found">Найдено: {[...match].filter((id) => isPosition(tree.byId.get(id))).length} поз.
              <button type="button" className="kpe-text-btn" onClick={() => { setQuery(''); setSearch(''); setShow('all') }}>сбросить</button></span>}
            <div className="kpe-seg" role="group" aria-label="Свернуть до уровня" title="Свернуть до уровня">
              {[1, 2, 3].map((lv) => <button key={lv} type="button" title={`Свернуть до уровня ${lv}`} onClick={() => setCollapsed(collapseToLevel(tree, lv))}>{lv}</button>)}
              <button type="button" title="Развернуть всё" onClick={() => setCollapsed(new Set())}>Все</button>
            </div>
            <span className={`kpe-save${saveState.errors ? ' is-error' : ''}`} role="status" aria-live="polite">
              {!writable ? (shown.status === 'archived' ? 'Только просмотр' : 'Только просмотр: нет права правки сметы')
                : saveState.errors ? <>Не сохранено: {saveState.errors}{saveState.message ? ` — ${saveState.message}` : ''} <button type="button" className="kpe-text-btn" onClick={retryFailed}>Повторить</button></>
                  : saveState.pending ? 'Сохраняем…' : 'Все изменения сохранены'}
            </span>
          </div>

          {writable && (
            <div className="kpe-selbar" role="toolbar" aria-label="Выделенное">
              <span className="kpe-muted">
                {cellSel ? `Ячеек: ${(cellSel.r2 - cellSel.r1 + 1) * (cellSel.c2 - cellSel.c1 + 1)}` : selection.size ? `Выделено строк: ${selection.size}` : 'Заливка: отметьте строки флажками (Shift — диапазон) или'}
              </span>
              <button type="button" className={`kpe-btn kpe-btn--sm${brush ? ' is-on' : ''}`} aria-pressed={brush} onClick={() => { setBrush((b) => !b); setCellSel(null) }}
                title="Протяните мышью по ячейкам, затем выберите цвет">ячейки</button>
              <span className="kpe-palette" role="group" aria-label="Заливка">
                {FILL_COLORS.map((c) => (
                  <button key={c.key} type="button" className="kpe-swatch" style={{ '--sw': c.key }} aria-label={`Залить: ${c.label}`} title={c.label}
                    disabled={!cellSel && !selection.size} onClick={() => applyFill(c.key)} />
                ))}
                <button type="button" className="kpe-swatch kpe-swatch--none" aria-label="Снять заливку" title="Снять заливку" disabled={!cellSel && !selection.size} onClick={() => applyFill(null)} />
              </span>
              {selection.size > 0 && <button type="button" className="kpe-btn kpe-btn--sm" onClick={() => { ensurePickers(); setDialog('bulk') }}>Тендер и подрядчик…</button>}
              {(selection.size > 0 || cellSel) && <button type="button" className="kpe-text-btn" onClick={clearSelection}>Снять выделение</button>}
            </div>
          )}

          {notice && (
            <div className={`kpe-notice kpe-notice--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
              {notice.text}
              <button type="button" className="kpe-icon-btn" aria-label="Скрыть" onClick={() => setNotice(null)}>✕</button>
            </div>
          )}

          <div className="kpe-main">
            <KpEstimateTable tree={tree} ids={ids} columns={COLUMNS} marks={marks} allocsByRow={allocsByRow}
              states={computed.states} sums={computed.sums} collapsed={collapsed} selection={selection} activeId={activeId}
              highlight={highlight} remoteIds={remoteIds} cellSel={cellSel} setCellSel={setCellSel} brush={brush} canEdit={writable}
              scrollTo={scrollTo} onToggle={toggle} onSelect={onSelect} onOpen={setActiveId} onEdit={onEditCell} />
          </div>
        </>
      )}

      {activeId && tree?.byId.has(activeId) && (
        <KpEstimateRowDialog tree={tree} rowId={activeId} marks={marks} allocsByRow={allocsByRow}
          states={computed.states} sums={computed.sums} canEdit={writable} pickers={pickers}
          onNeedPickers={ensurePickers} onMark={editMark} onAllocInsert={onAllocInsert} onAllocUpdate={onAllocUpdate}
          onAllocDelete={onAllocDelete} onClose={() => setActiveId(null)}
          loadRowLog={loadRowLog} logVersion={logVersion} onPrevNext={onPrevNext} />
      )}
      {dialog === 'import' && (
        <KpEstimateImportDialog objectId={objectId} current={info.estimate} currentRows={rows} currentMarks={marks} currentAllocs={allocsByRow}
          onClose={() => setDialog(null)}
          onDone={(res) => {
            setDialog(null)
            const t = res.transfer || {}
            const parts = [`Версия «${res.estimate.title}» загружена: строк ${Number(t.rows || res.estimate.row_count || 0).toLocaleString('ru-RU')}.`]
            if (t.previous_id) parts.push(`Перенесено отметок ${t.moved_marks || 0}, распределений ${t.moved_allocations || 0}.`)
            if (t.left_marks || t.left_allocations) parts.push(`У прежней версии остались (позиций нет в новом файле): отметок ${t.left_marks || 0}, распределений ${t.left_allocations || 0}.`)
            if (res.mastered) parts.push(`Списания листа «Освоение» — распределениями: ${res.mastered}.`)
            if (res.fileErrors?.length) parts.push(`Исходные файлы не сохранились: ${res.fileErrors.join('; ')} — смета при этом рабочая.`)
            setTransferNote(parts.join(' '))
            setViewEstimateId(null)
            loadInfo()
          }} />
      )}
      {dialog === 'history' && shown && <HistoryDialog estimateId={shown.id} onClose={() => setDialog(null)} onGoto={(rowId) => { setDialog(null); goTo(rowId) }} />}
      {dialog === 'passport' && shown && <PassportDialog estimate={shown} onClose={() => setDialog(null)} />}
      {dialog === 'bulk' && (
        <TenderBulkDialog count={selection.size} pickers={pickers} onClose={() => setDialog(null)} onApply={applyBulk}
          preview={(target) => planTenderAllocation({ rowIds: [...selection], tree, states: computed.states, allocsByRow, target })} />
      )}
    </section>
  )
}
