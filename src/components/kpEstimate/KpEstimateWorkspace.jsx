// Смета КП / ПЗ объекта — совместная работа экономистов с одним загруженным документом (вкладка «Смета» карточки
// объекта, миграция 20270215). Виды «КП» (укрупнённые позиции по системам) и «ПЗ» (прямые затраты и коммерция) — одни и
// те же строки: отметки и распределения в обоих одни. Дерево разделов, поиск, фильтры, свёртка, подробности строки,
// заливка строк и ячеек, групповые действия, история, выгрузка в Excel. Всё сохраняется само; правки коллег приходят по
// истории (раз в 10 с, пока вкладка открыта). Правила — utils/kpEstimate.js, запросы — services/kpEstimate.js.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { saveAs } from 'file-saver'
import { useRole } from '../../contexts/RoleContext'
import { downloadS3File } from '../FileDownload'
import {
  EMPTY_FILTERS, FILL_COLORS, STATUS_LABELS, allocationGroupKey, ancestorsOf, buildTree, collapseToLevel, computeStates,
  counterpartyKey, descendantsOf, filtersActive, fmtMoney, fmtMoneyShort, isPosition, linkedKpIds, linkedPzIds,
  markPayload, planTenderAllocation, responsibleKey, rowHaystack, rowMatchesFilters, searchTokens, visibleRowIds,
} from '../../utils/kpEstimate'
import { mergeNote } from '../../utils/dcRequestNotes'
import {
  deleteAllocation, deleteEstimate, fetchMark, insertAllocations, loadAllocations, loadEstimateInfo, loadLatestLogId, loadLog,
  loadLogSince, loadMarks, loadPickers, loadRows, loadSourceFiles, reloadForRows, saveMark, updateAllocation,
} from '../../services/kpEstimate'
import { COLUMN_GROUPS, FILLABLE, columnsFor } from './columns'
import KpEstimateTable from './KpEstimateTable'
import KpEstimateTree from './KpEstimateTree'
import KpEstimateDetail from './KpEstimateDetail'
import KpEstimateImportDialog from './KpEstimateImportDialog'
import { ExportDialog, HistoryDialog, PassportDialog, TenderBulkDialog } from './KpEstimateDialogs'
import './KpEstimate.css'

const POLL_MS = 10_000
const ECONOMIST_ROLES = new Set(['economist', 'economist_object'])

function readPrefs(objectId) {
  try { return JSON.parse(localStorage.getItem(`kpEstimate:ui:${objectId}`) || '{}') || {} } catch { return {} }
}
function writePrefs(objectId, prefs) {
  try { localStorage.setItem(`kpEstimate:ui:${objectId}`, JSON.stringify(prefs)) } catch { /* без памяти вида */ }
}
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
  if (/kp_estimate_allocations_pair|duplicate key/.test(msg)) return 'Этот тендер с этим подрядчиком у позиции уже есть — поправьте объём в существующей строке.'
  if (e?.code === '42501' || /row-level security|permission/i.test(msg)) return 'Нет права менять смету (раздел «Объекты: смета КП/ПЗ»).'
  return msg || 'Не удалось сохранить'
}

export default function KpEstimateWorkspace({ objectId, objectName = '' }) {
  const { canEdit, isAdmin, isSuperAdmin, user } = useRole()
  const editRight = canEdit('kp_estimate')
  const myId = user?.id || null
  const prefs0 = useMemo(() => readPrefs(objectId), [objectId])

  const [info, setInfo] = useState({ loading: true, estimate: null, versions: [], missing: false, error: '' })
  const [viewEstimateId, setViewEstimateId] = useState(null)
  const [rows, setRows] = useState(null)
  const [marks, setMarks] = useState(() => new Map())
  const [allocsByRow, setAllocsByRow] = useState(() => new Map())
  const [loadError, setLoadError] = useState('')
  const [view, setView] = useState(prefs0.view === 'pz' ? 'pz' : 'kp')
  const [hidden, setHidden] = useState(() => new Set(prefs0.hidden || []))
  const [treeOpen, setTreeOpen] = useState(prefs0.treeOpen !== false)
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [scope, setScope] = useState(null)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)
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

  const shown = useMemo(() => {
    if (viewEstimateId) return info.versions.find((v) => v.id === viewEstimateId) || null
    return info.estimate
  }, [info, viewEstimateId])
  const estimateId = shown?.id || null
  const writable = editRight && shown?.status === 'active'

  useEffect(() => { writePrefs(objectId, { view, hidden: [...hidden], treeOpen }) }, [objectId, view, hidden, treeOpen])

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
          loadSourceFiles([shown.kp_s3_document_id, shown.pz_s3_document_id]).catch(() => []),
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

  // ── Поиск и фильтры ─────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setSearch(query), 200)
    return () => clearTimeout(t)
  }, [query])
  const match = useMemo(() => {
    if (!tree || !computed) return null
    const tokens = searchTokens(search)
    const fa = filtersActive(filters)
    if (!tokens.length && !fa) return null
    const out = new Set()
    for (const r of tree.rows) {
      const mark = marks.get(r.id)
      const allocs = allocsByRow.get(r.id)
      if (fa && !rowMatchesFilters(r, mark, allocs, computed.states.get(r.id), filters)) continue
      if (tokens.length) {
        const hay = rowHaystack(r, mark, allocs)
        if (!tokens.every((t) => hay.includes(t))) continue
      }
      out.add(r.id)
    }
    return out
  }, [tree, computed, marks, allocsByRow, search, filters])
  const ids = useMemo(() => (tree ? visibleRowIds(tree, { view, scope, match, collapsed }) : []), [tree, match, scope, view, collapsed])
  useEffect(() => { setCellSel(null) }, [ids, view])
  const columns = useMemo(() => columnsFor(view, hidden), [view, hidden])
  const foundPositions = match ? [...match].filter((id) => isPosition(tree.byId.get(id))).length : null

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
    if (!window.confirm(`Удалить распределение${alloc.tender_label ? ` «${alloc.tender_label}»` : ''}${alloc.counterparty_name ? ` (${alloc.counterparty_name})` : ''}?`)) return
    try {
      await deleteAllocation(alloc.id)
      putAllocs([], [alloc.id])
    } catch (e) {
      setNotice({ kind: 'error', text: errText(e) })
    }
  }, [putAllocs])

  const ensurePickers = useCallback(() => {
    if (pickers || !writable) return
    setPickers({ loading: true, tenders: [], contracts: [], counterparties: [], employees: [], winners: [] })
    loadPickers(objectId).then((p) => {
      const employees = p.employees.map((e) => ({ ...e, isEconomist: ECONOMIST_ROLES.has(e.role) }))
        .sort((a, b) => (b.isEconomist - a.isEconomist) || String(a.display_name || a.full_name || '').localeCompare(String(b.display_name || b.full_name || ''), 'ru'))
      setPickers({ ...p, employees })
    }).catch(() => setPickers({ tenders: [], contracts: [], counterparties: [], employees: [], winners: [] }))
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

  // ── Выделение ───────────────────────────────────────────────────────────
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
      const keys = columns.slice(cellSel.c1, cellSel.c2 + 1).map((c) => c.key).filter((k) => FILLABLE.has(k))
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
  const applyResponsible = (empId) => {
    const emp = (pickers?.employees || []).find((e) => e.user_id === empId)
    for (const id of selection) {
      if (!tree.byId.get(id) || !isPosition(tree.byId.get(id))) continue
      editMark(id, { responsible_id: emp?.user_id || null, responsible_name: emp ? (emp.display_name || emp.full_name || emp.email) : null })
    }
  }

  // ── Переходы КП ↔ ПЗ ────────────────────────────────────────────────────
  const reveal = useCallback((targets, nextView, focusId) => {
    if (!tree) return
    if (nextView) setView(nextView)
    const v = nextView || view
    if (scope && !targets.every((id) => id === scope || descendantsOf(tree, scope).includes(id))) setScope(null)
    if (match && !targets.every((id) => match.has(id))) { setQuery(''); setSearch(''); setFilters(EMPTY_FILTERS) }
    setCollapsed((prev) => {
      const next = new Set(prev)
      for (const id of targets) for (const a of ancestorsOf(tree, id)) next.delete(a)
      return next
    })
    const focus = focusId || targets.find((id) => v !== 'pz' || tree.hasPz.has(id)) || targets[0]
    setHighlight(new Set(targets))
    setScrollTo({ id: focus, t: Date.now() })
    setTimeout(() => setHighlight(new Set()), 6000)
  }, [tree, view, scope, match])

  const onLink = useCallback((id) => {
    if (view === 'kp') {
      const targets = linkedPzIds(tree, id)
      if (targets.length) reveal(targets, 'pz', targets[0])
    } else {
      reveal(linkedKpIds(tree, id), 'kp', id)
    }
    setActiveId(id)
  }, [tree, view, reveal])
  const onShow = useCallback((id, v) => {
    if (v === 'pz') {
      const targets = linkedPzIds(tree, id)
      if (targets.length) reveal(targets, 'pz', tree.byId.get(id)?.pz ? id : targets[0])
    } else {
      reveal(linkedKpIds(tree, id), 'kp', id)
    }
  }, [tree, reveal])
  const onNavigate = useCallback((id) => {
    setActiveId(id)
    const nextView = view === 'pz' && !tree.hasPz.has(id) ? 'kp' : null
    reveal([id], nextView, id)
  }, [tree, view, reveal])
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

  // ── Выгрузка ────────────────────────────────────────────────────────────
  const doExport = async ({ scope: what, sheets }) => {
    const { exportRowIds, buildEstimateWorkbook } = await import('../../utils/kpEstimateExport')
    const picked = what === 'selected' ? [...selection] : (what === 'found' ? [...(match || [])] : null)
    const exportIds = exportRowIds(tree, picked)
    const label = what === 'selected' ? `выделенные строки (${selection.size})` : (what === 'found' ? `найденные (${match?.size || 0})` : 'вся смета')
    const buf = await buildEstimateWorkbook({ tree, marks, allocsByRow, states: computed.states, sums: computed.sums, total: computed.total, meta: shown.meta, estimate: shown },
      { ids: exportIds, sheets, scopeLabel: label })
    const day = new Date().toLocaleDateString('ru-RU')
    const name = `Смета КП-ПЗ — ${(shown.title || objectName || 'объект').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)} — ${day}.xlsx`
    saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name)
  }

  const applyTender = async (target) => {
    const plan = planTenderAllocation({ rowIds: [...selection], tree, states: computed.states, allocsByRow, tender: target })
    const created = plan.inserts.length ? await insertAllocations(estimateId, objectId, plan.inserts) : []
    const updated = []
    for (const u of plan.updates) {
      const alloc = (allocsByRow.get(u.row_id) || []).find((a) => a.id === u.id)
      const res = await updateAllocation(alloc, { pz_qty: u.pz_qty })
      if (res.allocation) updated.push(res.allocation)
    }
    putAllocs([...created, ...updated])
    setNotice({ kind: 'info', text: `В тендер ${target.tender_label} распределено позиций: ${created.length + updated.length}${plan.skipped.length ? `; без свободного остатка — ${plan.skipped.length}` : ''}.` })
  }

  // ── Escape: снять выделение, закрыть полноэкранный режим ────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || dialog) return
      if (cellSel || selection.size) { setCellSel(null); setSelection(new Set()); return }
      if (brush) { setBrush(false); return }
      if (fullscreen) setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, cellSel, selection, brush, fullscreen])

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
  const counts = total?.counts || {}
  const filterCount = Object.entries(filters).filter(([k, v]) => (Array.isArray(v) ? v.length : !!v) && k).length

  const responsibleOptions = []
  const tenderOptions = new Map()
  const cpOptions = new Map()
  if (tree) {
    const seen = new Set()
    for (const m of marks.values()) {
      const key = responsibleKey(m)
      if (key && !seen.has(key)) { seen.add(key); responsibleOptions.push({ key, label: m.responsible_name || 'сотрудник' }) }
    }
    for (const list of allocsByRow.values()) {
      for (const a of list) {
        const tk = allocationGroupKey(a)
        if ((a.tender_id || a.tender_label) && !tenderOptions.has(tk)) tenderOptions.set(tk, a.tender_label || 'тендер')
        const ck = counterpartyKey(a)
        if (ck && !cpOptions.has(ck)) cpOptions.set(ck, a.counterparty_name || 'подрядчик')
      }
    }
  }
  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }))
  const toggleStatus = (st) => setFilters((f) => ({ ...f, statuses: f.statuses.includes(st) ? f.statuses.filter((x) => x !== st) : [...f.statuses, st] }))

  return (
    <section className={`kpe-root${fullscreen ? ' is-fullscreen' : ''}`} aria-label="Смета КП / ПЗ">
      <header className="kpe-head">
        <div className="kpe-head-title">
          <h3 className="kpe-h">Смета КП / ПЗ{shown ? <span className="kpe-h-sub"> — {shown.title}</span> : null}</h3>
          {shown && (
            <p className="kpe-muted kpe-head-meta">
              {shown.status === 'archived' ? 'Прежняя версия' : 'Действующая версия'} от {new Date(shown.activated_at || shown.created_at).toLocaleDateString('ru-RU')}
              {shown.created_by_name ? `, загрузил(а) ${shown.created_by_name}` : ''}
              {sourceFiles.map((f) => (
                <button key={f.id} type="button" className="kpe-text-btn" title="Скачать исходный файл"
                  onClick={() => downloadS3File(f.s3_key, f.file_name).catch((e) => setNotice({ kind: 'error', text: e.message || String(e) }))}>
                  · {f.file_name}
                </button>
              ))}
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
          {shown && <button type="button" className="kpe-btn" onClick={() => setDialog('passport')}>Паспорт и коэффициенты</button>}
          {shown && <button type="button" className="kpe-btn" onClick={() => setDialog('history')}>История</button>}
          {shown && tree && <button type="button" className="kpe-btn" onClick={() => setDialog('export')}>Excel</button>}
          {editRight && !viewEstimateId && <button type="button" className="kpe-btn kpe-btn--primary" onClick={() => setDialog('import')}>{info.estimate ? 'Загрузить новую версию' : 'Загрузить смету'}</button>}
          {shown && (isAdmin || isSuperAdmin) && shown.status === 'archived' && (
            <button type="button" className="kpe-btn kpe-btn--danger-ghost" onClick={async () => {
              if (!window.confirm('Удалить прежнюю версию вместе с её отметками и историей?')) return
              try { await deleteEstimate(shown.id); setViewEstimateId(null); loadInfo() } catch (e) { setNotice({ kind: 'error', text: errText(e) }) }
            }}>Удалить версию</button>
          )}
          {tree && <button type="button" className="kpe-btn" aria-pressed={fullscreen} onClick={() => setFullscreen((f) => !f)}>{fullscreen ? 'Свернуть' : 'Во весь экран'}</button>}
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
          <p className="kpe-muted">Один документ для всех экономистов объекта: «КП до перекидок» (укрупнённые позиции по системам) и «Смета» (их связь с подробными позициями ПЗ и коэффициентами). По каждой позиции — примечания, заливка, уточнённый объём и причина, тендеры и подрядчики, остаток и ответственный.</p>
          {!editRight && <p className="kpe-muted">Загружает экономист с правом «Объекты: смета КП/ПЗ».</p>}
        </div>
      )}

      {shown && !tree && !loadError && <p className="kpe-muted">Загрузка строк…</p>}

      {tree && computed && (
        <>
          <div className="kpe-summary" role="group" aria-label="Итоги">
            <div className="kpe-tile"><span>Стоимость КП</span><b title={`${fmtMoney(total.total)} ₽`}>{fmtMoneyShort(total.total)}</b></div>
            {total.direct ? <div className="kpe-tile"><span>Прямые затраты ПЗ</span><b title={`${fmtMoney(total.direct)} ₽`}>{fmtMoneyShort(total.direct)}</b></div> : null}
            <div className="kpe-tile"><span>Распределено</span><b title={`${fmtMoney(total.distributedMoney)} ₽`}>{fmtMoneyShort(total.distributedMoney)}</b>
              <i>{total.total ? `${((total.distributedMoney / total.total) * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %` : ''}</i></div>
            <div className="kpe-tile"><span>Свободно</span><b title={`${fmtMoney(total.freeMoney)} ₽`}>{fmtMoneyShort(total.freeMoney)}</b></div>
            <button type="button" className={`kpe-tile kpe-tile--btn${filters.statuses.includes('over') ? ' is-on' : ''}${counts.over ? ' is-alert' : ''}`} onClick={() => toggleStatus('over')}>
              <span>Превышение</span><b>{counts.over || 0}</b></button>
            <button type="button" className={`kpe-tile kpe-tile--btn${filters.statuses.includes('none') ? ' is-on' : ''}`} onClick={() => toggleStatus('none')}>
              <span>Не распределено</span><b>{counts.none || 0}</b></button>
            <button type="button" className={`kpe-tile kpe-tile--btn${filters.statuses.includes('partial') ? ' is-on' : ''}`} onClick={() => toggleStatus('partial')}>
              <span>Частично</span><b>{counts.partial || 0}</b></button>
            <button type="button" className={`kpe-tile kpe-tile--btn${filters.changed ? ' is-on' : ''}`} onClick={() => setFilter({ changed: !filters.changed })}>
              <span>Объём изменён</span><b>{total.changed || 0}</b></button>
            <button type="button" className={`kpe-tile kpe-tile--btn${filters.withNote ? ' is-on' : ''}`} onClick={() => setFilter({ withNote: !filters.withNote })}>
              <span>С примечанием</span><b>{total.notes || 0}</b></button>
          </div>

          <div className="kpe-toolbar">
            <div className="kpe-seg" role="group" aria-label="Вид">
              <button type="button" className={view === 'kp' ? 'is-on' : ''} aria-pressed={view === 'kp'} onClick={() => setView('kp')}>КП</button>
              <button type="button" className={view === 'pz' ? 'is-on' : ''} aria-pressed={view === 'pz'} onClick={() => setView('pz')}>ПЗ</button>
            </div>
            <input type="search" className="kpe-field kpe-search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по разделам и позициям: код, наименование, примечание, тендер, подрядчик" aria-label="Поиск по разделам и позициям" />
            {match && <span className="kpe-muted kpe-found">Найдено: {match.size}{foundPositions !== null ? ` (позиций ${foundPositions})` : ''}</span>}
            <div className="kpe-pop-wrap">
              <button type="button" className={`kpe-btn${filterCount ? ' is-on' : ''}`} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((o) => !o)}>
                Фильтры{filterCount ? ` (${filterCount})` : ''}</button>
              {filtersOpen && (
                <div className="kpe-pop" role="dialog" aria-label="Фильтры">
                  <fieldset className="kpe-fieldset"><legend>Статус позиции</legend>
                    {['none', 'partial', 'full', 'over', 'empty'].map((st) => (
                      <label key={st}><input type="checkbox" checked={filters.statuses.includes(st)} onChange={() => toggleStatus(st)} /> {STATUS_LABELS[st]}</label>
                    ))}
                  </fieldset>
                  <fieldset className="kpe-fieldset"><legend>Отметки</legend>
                    <label><input type="checkbox" checked={filters.changed} onChange={() => setFilter({ changed: !filters.changed })} /> Объём изменён</label>
                    <label><input type="checkbox" checked={filters.contractOver} onChange={() => setFilter({ contractOver: !filters.contractOver })} /> По договорам больше, чем взято в тендер</label>
                    <label><input type="checkbox" checked={filters.withNote} onChange={() => setFilter({ withNote: !filters.withNote })} /> С примечанием</label>
                    <label><input type="checkbox" checked={filters.withFill} onChange={() => setFilter({ withFill: !filters.withFill })} /> С заливкой</label>
                    <label><input type="checkbox" checked={filters.noResponsible} onChange={() => setFilter({ noResponsible: !filters.noResponsible })} /> Без ответственного</label>
                  </fieldset>
                  <label className="kpe-block-label">Ответственный
                    <select className="kpe-field" value={filters.responsible} onChange={(e) => setFilter({ responsible: e.target.value })}>
                      <option value="">Любой</option>
                      {responsibleOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                    </select>
                  </label>
                  <label className="kpe-block-label">Тендер
                    <select className="kpe-field" value={filters.tender} onChange={(e) => setFilter({ tender: e.target.value })}>
                      <option value="">Любой</option>
                      {[...tenderOptions].map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                    </select>
                  </label>
                  <label className="kpe-block-label">Подрядчик
                    <select className="kpe-field" value={filters.counterparty} onChange={(e) => setFilter({ counterparty: e.target.value })}>
                      <option value="">Любой</option>
                      {[...cpOptions].map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                    </select>
                  </label>
                  <div className="kpe-pop-foot">
                    <button type="button" className="kpe-btn" onClick={() => setFilters(EMPTY_FILTERS)}>Сбросить</button>
                    <button type="button" className="kpe-btn kpe-btn--primary" onClick={() => setFiltersOpen(false)}>Готово</button>
                  </div>
                </div>
              )}
            </div>
            <div className="kpe-seg" role="group" aria-label="Свернуть до уровня">
              {[1, 2, 3].map((lv) => <button key={lv} type="button" title={`Свернуть до уровня ${lv}`} onClick={() => setCollapsed(collapseToLevel(tree, lv))}>{lv}</button>)}
              <button type="button" title="Развернуть всё" onClick={() => setCollapsed(new Set())}>Все</button>
            </div>
            <div className="kpe-pop-wrap">
              <details className="kpe-cols">
                <summary className="kpe-btn">Столбцы</summary>
                <div className="kpe-pop kpe-pop--small">
                  {COLUMN_GROUPS.map((g) => (
                    <label key={g.key}><input type="checkbox" checked={!hidden.has(g.key)}
                      onChange={() => setHidden((h) => { const n = new Set(h); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n })} /> {g.label}</label>
                  ))}
                </div>
              </details>
            </div>
            <button type="button" className="kpe-btn" aria-pressed={treeOpen} onClick={() => setTreeOpen((o) => !o)}>{treeOpen ? 'Скрыть разделы' : 'Разделы'}</button>
            <span className={`kpe-save${saveState.errors ? ' is-error' : ''}`} role="status" aria-live="polite">
              {!writable ? (shown.status === 'archived' ? 'Только просмотр' : 'Только просмотр: нет права правки сметы')
                : saveState.errors ? <>Не сохранено: {saveState.errors}{saveState.message ? ` — ${saveState.message}` : ''} <button type="button" className="kpe-text-btn" onClick={retryFailed}>Повторить</button></>
                  : saveState.pending ? 'Сохраняем…' : 'Все изменения сохранены'}
            </span>
          </div>

          {writable && (
            <div className="kpe-selbar" role="toolbar" aria-label="Выделенное">
              <button type="button" className={`kpe-btn${brush ? ' is-on' : ''}`} aria-pressed={brush} onClick={() => { setBrush((b) => !b); setCellSel(null) }}
                title="Протяните мышью по ячейкам, затем выберите цвет">Выделять ячейки</button>
              <span className="kpe-muted">
                {cellSel ? `Ячеек: ${(cellSel.r2 - cellSel.r1 + 1) * (cellSel.c2 - cellSel.c1 + 1)}` : selection.size ? `Выделено строк: ${selection.size}` : 'Выделите строки флажками (Shift — диапазон) или ячейки'}
              </span>
              <span className="kpe-palette" role="group" aria-label="Заливка">
                {FILL_COLORS.map((c) => (
                  <button key={c.key} type="button" className="kpe-swatch" style={{ '--sw': c.key }} aria-label={`Залить: ${c.label}`} title={c.label}
                    disabled={!cellSel && !selection.size} onClick={() => applyFill(c.key)} />
                ))}
                <button type="button" className="kpe-swatch kpe-swatch--none" aria-label="Снять заливку" title="Снять заливку" disabled={!cellSel && !selection.size} onClick={() => applyFill(null)} />
              </span>
              {selection.size > 0 && (
                <>
                  <select className="kpe-field kpe-field--compact" value="" aria-label="Назначить ответственного выделенным"
                    onFocus={ensurePickers} onChange={(e) => { if (e.target.value) applyResponsible(e.target.value === '__none' ? null : e.target.value) }}>
                    <option value="">Ответственный…</option>
                    <option value="__none">— снять —</option>
                    {(pickers?.employees || []).map((emp) => <option key={emp.user_id} value={emp.user_id}>{emp.display_name || emp.full_name || emp.email}{emp.isEconomist ? ' — экономист' : ''}</option>)}
                  </select>
                  <button type="button" className="kpe-btn" onClick={() => { ensurePickers(); setDialog('tender') }}>Распределить в тендер…</button>
                  <button type="button" className="kpe-btn" onClick={() => setDialog('export')}>Выгрузить выделенное</button>
                </>
              )}
              {(selection.size > 0 || cellSel) && <button type="button" className="kpe-text-btn" onClick={clearSelection}>Снять выделение</button>}
            </div>
          )}

          {notice && (
            <div className={`kpe-notice kpe-notice--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
              {notice.text}
              <button type="button" className="kpe-icon-btn" aria-label="Скрыть" onClick={() => setNotice(null)}>✕</button>
            </div>
          )}

          <div className={`kpe-main${treeOpen ? ' with-tree' : ''}${activeId ? ' with-detail' : ''}`}>
            {treeOpen && <KpEstimateTree tree={tree} sums={computed.sums} view={view} scope={scope} onScope={(id) => { setScope(id); if (id) setCollapsed((prev) => { const n = new Set(prev); n.delete(id); for (const a of ancestorsOf(tree, id)) n.delete(a); return n }) }} />}
            <KpEstimateTable tree={tree} ids={ids} columns={columns} view={view} marks={marks} allocsByRow={allocsByRow}
              states={computed.states} sums={computed.sums} collapsed={collapsed} selection={selection} activeId={activeId}
              highlight={highlight} remoteIds={remoteIds} cellSel={cellSel} setCellSel={setCellSel} brush={brush} canEdit={writable}
              scrollTo={scrollTo} onToggle={toggle} onSelect={onSelect} onOpen={setActiveId} onEdit={onEditCell} onLink={onLink} />
            {activeId && tree.byId.has(activeId) && (
              <KpEstimateDetail tree={tree} rowId={activeId} view={view} marks={marks} allocsByRow={allocsByRow}
                states={computed.states} sums={computed.sums} canEdit={writable} pickers={pickers} employees={pickers?.employees}
                onNeedPickers={ensurePickers} onMark={editMark} onAllocInsert={onAllocInsert} onAllocUpdate={onAllocUpdate}
                onAllocDelete={onAllocDelete} onNavigate={onNavigate} onShow={onShow} onClose={() => setActiveId(null)}
                loadRowLog={loadRowLog} logVersion={logVersion} onPrevNext={onPrevNext} />
            )}
          </div>
        </>
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
      {dialog === 'history' && shown && <HistoryDialog estimateId={shown.id} onClose={() => setDialog(null)} onGoto={(rowId) => { setDialog(null); if (tree?.byId.has(rowId)) onNavigate(rowId) }} />}
      {dialog === 'passport' && shown && <PassportDialog estimate={shown} onClose={() => setDialog(null)} />}
      {dialog === 'export' && tree && (
        <ExportDialog counts={{ selected: selection.size, found: match ? match.size : null, all: tree.rows.length }} onClose={() => setDialog(null)} onExport={doExport} />
      )}
      {dialog === 'tender' && (
        <TenderBulkDialog count={selection.size} pickers={pickers} onClose={() => setDialog(null)} onApply={applyTender}
          preview={(target) => planTenderAllocation({ rowIds: [...selection], tree, states: computed.states, allocsByRow, tender: target })} />
      )}
    </section>
  )
}
