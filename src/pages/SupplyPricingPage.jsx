import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { useRole } from '../contexts/RoleContext'
import useBodyClass from '../hooks/useBodyClass'
import AccessDenied from '../components/AccessDenied'
import SupplyMoneyCell from '../components/supply/SupplyMoneyCell'
import SupplyImportDialog from '../components/supply/SupplyImportDialog'
import SupplyConflictDialog from '../components/supply/SupplyConflictDialog'
import SupplyRateHistory from '../components/supply/SupplyRateHistory'
import { IconAlert, IconAlertCircle, IconCheck, IconClock, IconHistory, IconRefresh, IconTrash } from '../components/icons/ActionIcons'
import { IconFileSpreadsheet, IconUpload } from '../components/icons/BsmIcons'
import { IconSearch } from '../components/icons/ToolbarIcons'
import { fetchEmployees, employeesById } from '../services/employees'
import { requestDownloadUrl } from '../services/s3'
import {
  classifyError, clearRate, estimateSignatures, estimateVersion, fileVersion, loadChangeMarker, loadEstimateItems,
  loadPricingContext, loadRates, loadSources, loadVorFiles, saveRate,
} from '../services/supplyPricing'
import { rateUnitPrice } from '../utils/supplyRateHelpers'
import { formatAmount, parseAmount, roundMoney } from '../utils/money'
import { tenderObjectName } from '../utils/tenderDepartments'
import '../components/supply/SupplyPricing.css'
// Общий рабочий стиль разделов (docs/UI_GUIDELINES.md) — после стилей страницы.
import '../styles/fonts.css'
import '../styles/workUi.css'

// Страница расценки материалов ВОР снабжением (миграция 20261020). Позиции — разобранный лист «Материалы»
// файлов ВОР основного тендера (или вкладка «ВОР» карточки), цены — tender_vor_supply_rates основного
// тендера: введённое сразу видно в карточке («Расценки снабжения», «Сравнение КП», выгрузка) и в реестре
// «Расценки от снабжения СУ-10» (после его пересчёта, до 10 минут).
//
// Сохранение — по Enter / уходу из поля, с версией строки: чужая правка не перетирается молча (окно выбора).
// Пока значение не подтверждено сервером, оно держится в черновике (и в localStorage — на случай закрытия
// вкладки), сбой сети или перенос данных — повтор. Чужие правки подтягиваются опросом журнала раз в 20 с.

const POLL_MS = 20000
const RETRY_DELAYS = [5000, 15000, 30000, 60000]
const SAVED_FLASH_MS = 2000
const REMOTE_FLASH_MS = 6000
const VOLUME_FMT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 })
const fmtVolume = (v) => (v == null || v === '' ? '—' : VOLUME_FMT.format(Number(v)))
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '')
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
const posKey = (estimateName, k) => `${estimateName}∣${k}`
const draftsKey = (mainId) => `supply-pricing-drafts:${mainId}`
const ACTIVE_STATUSES = new Set(['saving', 'queued', 'error', 'conflict'])
const STATUS_CLASS = { 'Не начат': 'is-new', 'В работе': 'is-work', 'Завершён': 'is-done', 'Завершен': 'is-done', 'Не требуется': 'is-off', 'Не нужно': 'is-off' }

// Позиции из базы уже сгруппированы по ключу; на случай совпадения ключей (база нормализует так же, как
// браузер, но страхуемся) — склеиваем в одну позицию с несколькими единицами.
function mergePositions(list) {
  const out = new Map()
  for (const p of list || []) {
    const k = p.k
    if (!k) continue
    const prev = out.get(k)
    if (!prev) { out.set(k, p); continue }
    const parts = [...(prev.units || [{ unit: prev.unit, volume: prev.volume }]), ...(p.units || [{ unit: p.unit, volume: p.volume }])]
    const byUnit = new Map()
    for (const u of parts) {
      const key = String(u.unit || '').toLowerCase()
      const cur = byUnit.get(key) || { unit: u.unit, volume: null }
      if (u.volume != null) cur.volume = (cur.volume ?? 0) + Number(u.volume)
      byUnit.set(key, cur)
    }
    const units = [...byUnit.values()]
    out.set(k, units.length === 1
      ? { ...prev, unit: units[0].unit, volume: units[0].volume, units: undefined }
      : { ...prev, unit: null, volume: null, units })
  }
  return [...out.values()]
}

// Сумма позиции по сохранённой расценке: введённая/посчитанная базой при том же объёме, иначе цена × объём.
function rateTotal(rate, position) {
  const price = rateUnitPrice(rate)
  if (!Number.isFinite(price)) return null
  if (position.units) {
    const vols = position.units.filter((u) => u.volume != null)
    return vols.length ? roundMoney(vols.reduce((s, u) => s + price * Number(u.volume), 0)) : null
  }
  if (position.volume == null) return null
  const v = Number(position.volume)
  if (rate.supply_total != null && rate.volume_at_input != null && Number(rate.volume_at_input) === v) return Number(rate.supply_total)
  return roundMoney(price * v)
}

// Что показать в строке: сохранённое, а поверх — черновик (пока сервер не подтвердил).
function rowView(position, rate, draft) {
  const volume = position.units || position.volume == null ? null : Number(position.volume)
  let unitPrice = rate ? rateUnitPrice(rate) : null
  let total = rate ? rateTotal(rate, position) : null
  let primary = rate?.price_input === 'total' ? 'total' : 'unit'
  if (draft?.mode === 'clear') {
    unitPrice = null
    total = null
  } else if (draft?.mode === 'unit') {
    unitPrice = roundMoney(draft.value)
    total = volume > 0 ? roundMoney(unitPrice * volume) : null
    primary = 'unit'
  } else if (draft?.mode === 'total') {
    total = roundMoney(draft.value)
    unitPrice = volume > 0 ? total / volume : null
    primary = 'total'
  }
  const volumeChanged = !!rate && (rate.price_input === 'unit' || rate.price_input === 'total')
    && rate.volume_at_input != null && volume != null && Number(rate.volume_at_input) !== volume
  return { unitPrice, total, primary, volume, volumeChanged, priced: unitPrice != null }
}

const loadStoredDrafts = (mainId) => {
  try { return JSON.parse(localStorage.getItem(draftsKey(mainId)) || '{}') || {} } catch { return {} }
}
const storeDrafts = (mainId, drafts) => {
  try {
    const keep = {}
    for (const [k, d] of Object.entries(drafts)) {
      if (ACTIVE_STATUSES.has(d.status)) keep[k] = { mode: d.mode, value: d.value, estimateName: d.estimateName, at: d.at }
    }
    if (Object.keys(keep).length) localStorage.setItem(draftsKey(mainId), JSON.stringify(keep))
    else localStorage.removeItem(draftsKey(mainId))
  } catch { /* приватный режим — черновик только в памяти */ }
}

export default function SupplyPricingPage() {
  const { tenderId } = useParams()
  const { canEdit, scopedObjectIds, user } = useRole()
  useBodyClass('ui-work-portal')
  const canEditRole = canEdit('tenders') || canEdit('tenders_materials')
  const myId = user?.id || null

  const [ctx, setCtx] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [missing, setMissing] = useState(false)
  const [files, setFiles] = useState([])
  const [sources, setSources] = useState([])
  const [rates, setRates] = useState([])
  const [signatures, setSignatures] = useState(null) // Map — только если есть позиции из вкладки «ВОР»
  const [activeDoc, setActiveDoc] = useState(null)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [drafts, setDrafts] = useState({})
  const [flash, setFlash] = useState({}) // key → { kind: 'saved' | 'remote', by, at }
  const [conflict, setConflict] = useState(null)
  const [historyFor, setHistoryFor] = useState(null)
  const [importOpen, setImportOpen] = useState(false)
  const [employees, setEmployees] = useState(() => new Map())
  const [notice, setNotice] = useState('')

  const mainId = ctx?.mainId || null
  const editable = canEditRole && !!ctx && !ctx.locked && !missing
  const ratesRef = useRef(rates)
  const draftsRef = useRef(drafts)
  const inflight = useRef(new Set())
  const queued = useRef(new Map())
  const retryTimers = useRef(new Map())
  const recentlyDeleted = useRef(new Map())
  const recentLocal = useRef(new Map())
  const markerRef = useRef(null)
  const runSaveRef = useRef(null)
  ratesRef.current = rates
  draftsRef.current = drafts

  // ── Загрузка ──────────────────────────────────────────────────────────────────────────────────────
  const loadData = useCallback(async (id) => {
    const [vorFiles, srcs, rateRows, marker] = await Promise.all([loadVorFiles(id), loadSources(id), loadRates(id), loadChangeMarker(id)])
    markerRef.current = marker
    setFiles(vorFiles)
    setSources(srcs)
    setRates(rateRows)
    if (srcs.some((s) => s.source === 'vor_tab')) {
      loadEstimateItems(id).then((items) => setSignatures(estimateSignatures(items))).catch(() => setSignatures(null))
    }
    return srcs
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadError('')
    setMissing(false)
    ;(async () => {
      try {
        const c = await loadPricingContext(tenderId)
        if (!alive) return
        setCtx(c)
        if (!c) return
        try {
          const srcs = await loadData(c.mainId)
          if (!alive) return
          setActiveDoc((prev) => prev ?? srcs[0]?.estimate_name ?? null)
          const stored = loadStoredDrafts(c.mainId)
          if (Object.keys(stored).length) {
            setDrafts(Object.fromEntries(Object.entries(stored).map(([k, d]) => [k, {
              ...d, status: 'error', kind: 'stored', message: 'Не сохранено при прошлом открытии страницы — повторите или отмените ввод',
            }])))
          }
        } catch (e) {
          if (!alive) return
          if (e.kind === 'missing') setMissing(true)
          else setLoadError(e.message || 'Не удалось загрузить расценку')
        }
      } catch (e) {
        if (alive) setLoadError(e.message || 'Не удалось загрузить тендер')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [tenderId, loadData])

  // ФИО тех, кто менял цены, — по запросу (журнал хранит ФИО сам, строки расценок — только id).
  useEffect(() => {
    if (!mainId) return
    fetchEmployees().then((list) => setEmployees(employeesById(list))).catch(() => {})
  }, [mainId])
  const nameOf = useCallback((userId) => {
    if (!userId) return null
    const e = employees.get(userId)
    return e?.display_name || e?.full_name || null
  }, [employees])

  // Черновики переживают закрытие вкладки.
  useEffect(() => { if (mainId) storeDrafts(mainId, drafts) }, [mainId, drafts])

  // Уход со страницы с несохранённым — предупреждение браузера.
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (Object.values(draftsRef.current).some((d) => ACTIVE_STATUSES.has(d.status))) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  useEffect(() => () => { for (const t of retryTimers.current.values()) clearTimeout(t) }, [])

  // ── Данные для показа ─────────────────────────────────────────────────────────────────────────────
  const ratesByKey = useMemo(() => {
    const m = new Map()
    for (const r of rates) {
      const key = posKey(r.estimate_name, r.material_key)
      if (!m.has(key)) m.set(key, [])
      m.get(key).push(r)
    }
    for (const list of m.values()) list.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))
    return m
  }, [rates])

  const docViews = useMemo(() => sources.map((s) => {
    const positions = mergePositions(s.positions)
    const keys = new Set(positions.map((p) => p.k))
    let priced = 0
    let total = 0
    for (const p of positions) {
      const rate = ratesByKey.get(posKey(s.estimate_name, p.k))?.[0]
      if (!rate) continue
      priced += 1
      total += rateTotal(rate, p) || 0
    }
    const orphans = rates.filter((r) => r.estimate_name === s.estimate_name && !keys.has(r.material_key))
    return { source: s, name: s.estimate_name, positions, priced, total: roundMoney(total), orphans }
  }), [sources, ratesByKey, rates])

  const doc = docViews.find((d) => d.name === activeDoc) || docViews[0] || null
  const grand = useMemo(() => docViews.reduce((a, d) => ({
    positions: a.positions + d.positions.length, priced: a.priced + d.priced, total: roundMoney(a.total + d.total),
  }), { positions: 0, priced: 0, total: 0 }), [docViews])

  // Что изменилось в источниках: удалённый или заменённый файл, перезагруженный ВОР карточки, новые файлы.
  const staleness = useMemo(() => {
    const byDoc = new Map()
    const fileById = new Map(files.map((f) => [f.id, f]))
    for (const s of sources) {
      if (s.source === 'vor_file') {
        if (!s.s3_document_id) byDoc.set(s.estimate_name, 'Файл-источник удалён из «ВОРов и РД» — позиции остались от него.')
        else {
          const f = fileById.get(s.s3_document_id)
          if (f && s.source_version && fileVersion(f) !== s.source_version) byDoc.set(s.estimate_name, 'Файл ВОР заменён — обновите позиции.')
        }
      } else if (signatures) {
        const sig = signatures.get(s.estimate_name)
        if (!sig) byDoc.set(s.estimate_name, 'ВОР удалён из вкладки «ВОР» карточки — позиции остались от него.')
        else if (s.source_version && estimateVersion(sig) !== s.source_version) byDoc.set(s.estimate_name, 'ВОР в карточке перезагружен — обновите позиции.')
      }
    }
    const used = new Set(sources.map((s) => s.s3_document_id).filter(Boolean))
    const newFiles = files.filter((f) => !used.has(f.id))
    return { byDoc, newFiles }
  }, [files, sources, signatures])

  const visibleRows = useMemo(() => {
    if (!doc) return []
    const q = search.trim().toLowerCase()
    return doc.positions.map((p, index) => {
      const key = posKey(doc.name, p.k)
      const list = ratesByKey.get(key) || []
      const rate = list[0] || null
      const draft = drafts[key] || null
      return { p, index, key, rate, duplicates: list.slice(1), draft, view: rowView(p, rate, draft) }
    }).filter((r) => {
      if (q && !r.p.name.toLowerCase().includes(q)) return false
      if (filter === 'unpriced') return !r.view.priced
      if (filter === 'priced') return r.view.priced
      return true
    })
  }, [doc, ratesByKey, drafts, search, filter])

  // ── Сохранение ────────────────────────────────────────────────────────────────────────────────────
  const setDraft = useCallback((key, value) => {
    setDrafts((prev) => {
      const next = { ...prev }
      if (value) next[key] = { ...value, at: value.at || new Date().toISOString() }
      else delete next[key]
      return next
    })
  }, [])

  const flashRow = useCallback((key, value, ms) => {
    setFlash((prev) => ({ ...prev, [key]: value }))
    setTimeout(() => setFlash((prev) => {
      if (prev[key] !== value) return prev
      const next = { ...prev }
      delete next[key]
      return next
    }), ms)
  }, [])

  // Строка из ответа сервера — в список расценок (версия новее местной не затирается опросом).
  const applyRow = useCallback((oldRate, row) => {
    setRates((prev) => {
      let next = prev
      if (oldRate && !row) {
        recentlyDeleted.current.set(oldRate.id, Date.now())
        next = prev.filter((r) => r.id !== oldRate.id)
      } else if (row) {
        recentLocal.current.set(row.id, Date.now())
        const i = prev.findIndex((r) => r.id === row.id)
        next = i === -1 ? [...prev, row] : prev.map((r) => (r.id === row.id ? row : r))
      }
      return next
    })
  }, [])

  const reloadContext = useCallback(async () => {
    try {
      const c = await loadPricingContext(tenderId)
      if (c) setCtx(c)
    } catch { /* останется прежнее */ }
  }, [tenderId])

  const runSave = useCallback(async (key, intent) => {
    if (inflight.current.has(key)) {
      queued.current.set(key, intent)
      setDraft(key, { ...intent, status: 'queued' })
      return
    }
    const timer = retryTimers.current.get(key)
    if (timer) { clearTimeout(timer); retryTimers.current.delete(key) }
    inflight.current.add(key)
    setDraft(key, { ...intent, status: 'saving' })
    const rate = (() => {
      const [estimateName, k] = key.split('∣')
      const list = ratesRef.current.filter((r) => r.estimate_name === estimateName && r.material_key === k)
      return list.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0] || null
    })()
    try {
      const res = intent.mode === 'clear'
        ? (rate ? await clearRate(rate) : { status: 'ok', row: null })
        : await saveRate({ rate, mainId, estimateName: intent.estimateName, position: intent.position, mode: intent.mode, value: intent.value })
      if (res.status === 'ok') {
        applyRow(rate, res.row)
        if (!queued.current.has(key)) setDraft(key, null)
        flashRow(key, { kind: 'saved' }, SAVED_FLASH_MS)
      } else {
        if (res.current) applyRow(null, res.current)
        else if (rate) applyRow(rate, null)
        setDraft(key, { ...intent, status: 'conflict' })
        setConflict({ key, intent, current: res.current, position: intent.position })
      }
    } catch (e) {
      const kind = e.kind || classifyError(e)?.kind || 'error'
      const attempts = (draftsRef.current[key]?.attempts || 0) + 1
      setDraft(key, { ...intent, status: 'error', kind, message: e.message, attempts })
      if (kind === 'retry') {
        const delay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]
        retryTimers.current.set(key, setTimeout(() => {
          retryTimers.current.delete(key)
          const d = draftsRef.current[key]
          if (d?.status === 'error' && d.kind === 'retry') runSaveRef.current(key, { mode: d.mode, value: d.value, estimateName: d.estimateName, position: d.position })
        }, delay))
      }
      if (kind === 'locked') reloadContext()
    } finally {
      inflight.current.delete(key)
      const next = queued.current.get(key)
      if (next) {
        queued.current.delete(key)
        runSaveRef.current(key, next)
      }
    }
  }, [mainId, applyRow, setDraft, flashRow, reloadContext])
  runSaveRef.current = runSave

  // Ввод в поле цены (field 'unit') или суммы ('total').
  const commit = useCallback((docName, row, field, raw) => {
    const { p, key, rate, view } = row
    const value = parseAmount(raw)
    const intentBase = { estimateName: docName, position: p }
    if (value == null) {
      if (!rate && !drafts[key]) return
      if (!rate) { setDraft(key, null); return }
      runSave(key, { ...intentBase, mode: 'clear', value: null })
      return
    }
    if (value <= 0) {
      setDraft(key, { ...intentBase, mode: field, value, status: 'error', kind: 'invalid', message: 'Цена и сумма должны быть больше нуля' })
      return
    }
    if (field === 'total' && !(view.volume > 0)) {
      setDraft(key, { ...intentBase, mode: field, value, status: 'error', kind: 'invalid', message: 'Сумму можно ввести только у позиции с объёмом' })
      return
    }
    // То же, что уже показано, — не пишем (иначе пустая правка поменяла бы способ ввода).
    const shown = field === 'unit' ? view.unitPrice : view.total
    if (shown != null && roundMoney(value) === roundMoney(shown) && !drafts[key] && !view.volumeChanged) return
    runSave(key, { ...intentBase, mode: field, value })
  }, [drafts, runSave, setDraft])

  const retryDraft = (key) => {
    const d = drafts[key]
    if (!d) return
    const estimateName = d.estimateName || key.split('∣')[0]
    const owner = docViews.find((x) => x.name === estimateName)
    const position = d.position || owner?.positions.find((p) => posKey(estimateName, p.k) === key)
    if (!position) return
    runSave(key, { mode: d.mode, value: d.value, estimateName, position })
  }
  const discardDraft = (key) => {
    const timer = retryTimers.current.get(key)
    if (timer) { clearTimeout(timer); retryTimers.current.delete(key) }
    queued.current.delete(key)
    setDraft(key, null)
  }

  // Объём позиции изменился после ввода: цена за единицу остаётся, сумма пересчитывается по новому объёму.
  const acceptVolume = (row) => {
    const { p, key, rate, view } = row
    if (!rate) return
    if (rate.price_input === 'total' && view.volume > 0) {
      runSave(key, { estimateName: doc.name, position: p, mode: 'total', value: roundMoney(rateUnitPrice(rate) * view.volume) })
    } else {
      runSave(key, { estimateName: doc.name, position: p, mode: 'unit', value: Number(rate.input_value ?? rate.supply_price) })
    }
  }

  const removeDuplicates = async (row) => {
    for (const r of row.duplicates) {
      try { await clearRate(r); applyRow(r, null) } catch (e) { setNotice(e.message); break }
    }
  }

  const removeOrphan = async (rate) => {
    if (!window.confirm(`Удалить цену «${rate.material_name}»? Позиции с таким наименованием в текущем ВОР нет. Удаление записывается в журнал.`)) return
    try {
      const res = await clearRate(rate)
      if (res.status === 'ok') applyRow(rate, null)
      else { if (res.current) applyRow(null, res.current); setNotice('Цену уже изменил другой пользователь — проверьте.') }
    } catch (e) {
      setNotice(e.message)
    }
  }

  // ── Синхронизация: опрос журнала, пока вкладка видна ──────────────────────────────────────────────
  const refreshFromServer = useCallback(async () => {
    if (!mainId) return
    const [srcs, rateRows] = await Promise.all([loadSources(mainId), loadRates(mainId)])
    const now = Date.now()
    for (const [id, at] of recentlyDeleted.current) if (now - at > 60000) recentlyDeleted.current.delete(id)
    for (const [id, at] of recentLocal.current) if (now - at > 60000) recentLocal.current.delete(id)
    // Ответ опроса мог уйти до нашей записи: строку новее (или только что вставленную) не затираем,
    // только что удалённую — не возвращаем.
    const prev = ratesRef.current
    const local = new Map(prev.map((r) => [r.id, r]))
    const server = new Set(rateRows.map((r) => r.id))
    const remote = []
    const merged = rateRows
      .filter((r) => !recentlyDeleted.current.has(r.id))
      .map((r) => {
        const l = local.get(r.id)
        if (l && l.row_version > r.row_version) return l
        if (r.updated_by && r.updated_by !== myId && (!l || l.row_version !== r.row_version)) remote.push(r)
        return r
      })
    for (const l of prev) if (!server.has(l.id) && recentLocal.current.has(l.id)) merged.push(l)
    setRates(merged)
    for (const r of remote) flashRow(posKey(r.estimate_name, r.material_key), { kind: 'remote', by: r.updated_by, at: r.updated_at }, REMOTE_FLASH_MS)
    setSources(srcs)
  }, [mainId, myId, flashRow])

  useEffect(() => {
    if (!mainId || missing) return undefined
    let busy = false
    const tick = async () => {
      if (busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        const marker = await loadChangeMarker(mainId)
        if (markerRef.current !== null && marker !== markerRef.current) await refreshFromServer()
        markerRef.current = marker
      } catch { /* сеть — следующий раз */ } finally {
        busy = false
      }
    }
    const id = setInterval(tick, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [mainId, missing, refreshFromServer])

  // ── Выгрузка в Excel: по листу на ВОР, как лист «Материалы» ВОР ─────────────────────────────────────
  const exportExcel = () => {
    const wb = XLSX.utils.book_new()
    const used = new Set()
    for (const d of docViews) {
      const aoa = [['№', 'Наименование', 'Ед. изм.', 'Объём', 'Цена за ед. с доставкой и НДС, ₽', 'Итого с НДС, ₽']]
      d.positions.forEach((p, i) => {
        const rate = ratesByKey.get(posKey(d.name, p.k))?.[0] || null
        const v = rowView(p, rate, null)
        aoa.push([i + 1, p.name, p.units ? p.units.map((u) => u.unit).filter(Boolean).join(', ') : (p.unit || ''),
          p.units ? p.units.map((u) => `${fmtVolume(u.volume)} ${u.unit || ''}`).join('; ') : (p.volume ?? ''),
          v.unitPrice != null ? roundMoney(v.unitPrice) : '', v.total ?? ''])
      })
      aoa.push(['', 'Итого', '', '', '', d.total])
      const ws = XLSX.utils.aoa_to_sheet(aoa)
      ws['!cols'] = [{ wch: 6 }, { wch: 60 }, { wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 18 }]
      let name = (docViews.length === 1 ? 'Материалы' : `Материалы ${d.name}`).replace(/[\\/:*?[\]]/g, ' ').slice(0, 31)
      for (let i = 2; used.has(name); i++) name = `${name.slice(0, 27)} (${i})`
      used.add(name)
      XLSX.utils.book_append_sheet(wb, ws, name)
    }
    const num = ctx?.main?.public_tender_number ?? ''
    const desc = String(ctx?.main?.work_description || '').slice(0, 40).replace(/[\\/:*?"<>|]/g, '')
    XLSX.writeFile(wb, `Расценка снабжения_№${num}_${desc}.xlsx`)
  }

  const downloadSource = async (s) => {
    const f = files.find((x) => x.id === s.s3_document_id)
    if (!f) return
    try {
      const { presigned_url } = await requestDownloadUrl(f.s3_key, { fileName: f.file_name, download: true })
      window.location.assign(presigned_url)
    } catch (e) {
      setNotice(`Файл не скачался: ${e.message}`)
    }
  }

  // ── Отрисовка ─────────────────────────────────────────────────────────────────────────────────────
  if (loading) return <div className="loading">Загрузка...</div>
  if (loadError) {
    return (
      <div className="ui-work sp-page">
        <Link to="/tenders/materials" className="sp-back">← Тендеры на материалы</Link>
        <p className="sp-error-text">{loadError}</p>
      </div>
    )
  }
  if (!ctx) {
    return <AccessDenied title="Тендер не найден" message="Тендера нет или он удалён." backTo="/tenders/materials" />
  }
  const main = ctx.main || ctx.opened
  if (scopedObjectIds.length > 0 && !scopedObjectIds.includes(main?.object_id)) {
    return (
      <AccessDenied
        title="Тендер недоступен"
        message="Этот тендер относится к другому объекту, вне вашего доступа. Обратитесь к администратору, если нужен доступ."
        backTo="/tenders/materials"
      />
    )
  }

  const materials = ctx.materials
  const stale = doc ? staleness.byDoc.get(doc.name) : null
  const pending = Object.values(drafts).filter((d) => ACTIVE_STATUSES.has(d.status)).length
  const readOnlyReason = ctx.locked
    ? 'Тендер на материалы завершён — расценки только для чтения. Чтобы изменить, верните тендеру на материалы прежний статус.'
    : !canEditRole ? 'Только просмотр: вводить цены могут снабжение и тендерный отдел (право правки раздела).' : ''

  return (
    <div className="ui-work sp-page">
      <Link to="/tenders/materials" className="sp-back">← Тендеры на материалы</Link>
      <header className="sp-header">
        <div className="sp-title">
          <h2>Расценка материалов</h2>
          <div className="sp-subtitle">
            <span className="ui-num">№ {main?.public_tender_number ?? '—'}</span>
            <span>{tenderObjectName(main)}</span>
            <span className="sp-desc">{main?.work_description}</span>
          </div>
          <div className="sp-meta">
            {materials && <span className={`sp-status ${STATUS_CLASS[materials.status] || 'is-new'}`}>{materials.status}</span>}
            {materials?.materials_proposal_deadline && <span>Срок КП: <b className="ui-num">{fmtDate(materials.materials_proposal_deadline)}</b></span>}
            {materials?.materials_resp_name && <span>Ответственный снабжения: <b>{materials.materials_resp_name}</b></span>}
          </div>
        </div>
        {!missing && grand.positions > 0 && (
          <div className="sp-summary" aria-live="polite">
            <div>Расценено <b className="ui-num">{grand.priced}</b> из <b className="ui-num">{grand.positions}</b></div>
            <div>Итого <b className="ui-num">{formatAmount(grand.total)} ₽</b></div>
          </div>
        )}
      </header>

      {missing && (
        <div className="sp-banner is-warn" role="status">
          <IconAlert size={16} />
          <span>Расценка на сайте ещё не включена: на сервере не применено обновление базы. Сообщите администратору.</span>
        </div>
      )}
      {readOnlyReason && !missing && <div className="sp-banner" role="status"><IconAlertCircle size={16} /><span>{readOnlyReason}</span></div>}
      {ctx.orphan && <div className="sp-banner is-warn"><IconAlert size={16} /><span>Тендер на материалы не связан с основным тендером — файлы ВОР ищутся у него самого.</span></div>}
      {notice && (
        <div className="sp-banner is-warn" role="alert">
          <IconAlert size={16} /><span>{notice}</span>
          <button type="button" className="sp-link-btn" onClick={() => setNotice('')}>Скрыть</button>
        </div>
      )}
      {pending > 0 && (
        <div className="sp-banner is-warn" role="status">
          <IconClock size={16} /><span>Не сохранено значений: {pending}. Не закрывайте страницу, пока они не сохранятся.</span>
        </div>
      )}

      {!missing && docViews.length === 0 && (
        <div className="sp-empty">
          <p>Позиции ещё не загружены.</p>
          <p className="sp-muted">
            {files.length
              ? `В «ВОРах и РД» тендера файлов ВОР: ${files.length}. Позиции берутся с листа «Материалы».`
              : 'В «ВОРах и РД» тендера нет файлов ВОР в Excel — позиции можно взять из вкладки «ВОР» карточки тендера.'}
          </p>
          {editable
            ? <button type="button" className="btn-primary" onClick={() => setImportOpen(true)}><IconUpload width={16} height={16} /> Загрузить позиции из ВОР</button>
            : <p className="sp-muted">Позиции загружает снабжение или тендерный отдел.</p>}
        </div>
      )}

      {!missing && docViews.length > 0 && (
        <>
          <div className="sp-docs" role="tablist" aria-label="ВОР тендера">
            {docViews.map((d) => {
              const complete = d.positions.length > 0 && d.priced === d.positions.length
              return (
                <button
                  key={d.name}
                  type="button"
                  role="tab"
                  aria-selected={d.name === doc?.name}
                  className={`sp-doc${d.name === doc?.name ? ' active' : ''}${complete ? ' is-complete' : ''}`}
                  onClick={() => setActiveDoc(d.name)}
                >
                  {complete && <IconCheck size={14} />}
                  <span className="sp-doc-name">{d.name}</span>
                  <span className="sp-doc-count ui-num">{d.priced}/{d.positions.length}</span>
                  {staleness.byDoc.has(d.name) && <span className="sp-doc-stale" title={staleness.byDoc.get(d.name)} aria-label="ВОР изменился"><IconAlert size={12} /></span>}
                </button>
              )
            })}
          </div>

          {doc && (
            <div className="sp-source">
              {doc.source.source === 'vor_file'
                ? <>Источник: файл «{doc.source.file_name || 'удалён'}», лист «{doc.source.sheet_name || 'Материалы'}»</>
                : <>Источник: вкладка «ВОР» карточки тендера</>}
              <span className="sp-muted"> · загружено {fmtTime(doc.source.parsed_at)}{nameOf(doc.source.parsed_by) ? `, ${nameOf(doc.source.parsed_by)}` : ''}</span>
              {doc.source.source === 'vor_file' && doc.source.s3_document_id && files.some((f) => f.id === doc.source.s3_document_id) && (
                <button type="button" className="sp-link-btn" onClick={() => downloadSource(doc.source)}>скачать файл</button>
              )}
            </div>
          )}
          {(stale || staleness.newFiles.length > 0) && (
            <div className="sp-banner is-warn" role="status">
              <IconRefresh size={16} />
              <span>
                {stale || ''}{stale && staleness.newFiles.length ? ' ' : ''}
                {staleness.newFiles.length > 0 && `В «ВОРах и РД» есть файлы, ещё не загруженные в расценку: ${staleness.newFiles.length}.`}
              </span>
              {editable && <button type="button" className="sp-link-btn" onClick={() => setImportOpen(true)}>Обновить позиции</button>}
            </div>
          )}

          <div className="sp-toolbar">
            <label className="ui-search sp-search">
              <IconSearch size={16} />
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по наименованию" aria-label="Поиск по наименованию материала" />
            </label>
            <div className="sp-filter" role="group" aria-label="Показать позиции">
              {[['all', 'Все'], ['unpriced', 'Не расценены'], ['priced', 'Расценены']].map(([k, label]) => (
                <button key={k} type="button" className={`sp-filter-btn${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
              ))}
            </div>
            <div className="sp-toolbar-right">
              <span className="sp-muted sp-registry-hint">В реестре «Расценки от снабжения СУ-10» — в течение 10 минут</span>
              <button type="button" className="btn-secondary" onClick={exportExcel}><IconFileSpreadsheet width={16} height={16} /> Скачать Excel</button>
              {editable && <button type="button" className="btn-secondary" onClick={() => setImportOpen(true)}><IconUpload width={16} height={16} /> Позиции из ВОР</button>}
            </div>
          </div>

          {doc && (
            <div className="table-container sp-table-wrap">
              <table className="data-table sp-table">
                <colgroup>
                  <col className="sp-c-num" /><col className="sp-c-name" /><col className="sp-c-unit" /><col className="sp-c-vol" />
                  <col className="sp-c-price" /><col className="sp-c-total" /><col className="sp-c-state" />
                </colgroup>
                <thead>
                  <tr>
                    <th>№</th>
                    <th>Наименование</th>
                    <th>Ед. изм.</th>
                    <th className="ui-money">Объём</th>
                    <th className="ui-money" title="Как в листе «Материалы» ВОР: цена с учётом доставки и НДС">Цена за ед. с доставкой и НДС, ₽</th>
                    <th className="ui-money" title="Объём × цена за единицу, с НДС">Итого с НДС, ₽</th>
                    <th><span className="ui-sr-only">Состояние</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 && (
                    <tr><td colSpan={7} className="no-data">{search || filter !== 'all' ? 'Ничего не найдено' : 'В этом ВОР нет позиций'}</td></tr>
                  )}
                  {visibleRows.map((row) => {
                    const { p, key, rate, draft, view, index } = row
                    const f = flash[key]
                    const mixed = !!p.units
                    const totalDisabled = !editable || mixed || !(view.volume > 0)
                    return (
                      <tr
                        key={key}
                        className={[
                          !view.priced && 'is-unpriced',
                          f?.kind === 'remote' && 'is-remote',
                          draft?.status === 'error' && 'is-error',
                          draft?.status === 'conflict' && 'is-conflict',
                        ].filter(Boolean).join(' ')}
                      >
                        <td className="ui-rownum" data-label="№">{index + 1}</td>
                        <td className="sp-name" data-label="Наименование">
                          <span>{p.name}</span>
                          {mixed && <span className="sp-hint">разные ед. изм.: цена одна на все строки ВОР, сумма — по каждой</span>}
                          {row.duplicates.length > 0 && (
                            <span className="sp-hint is-warn">
                              ещё цен на это наименование: {row.duplicates.length} (из Excel)
                              {editable && <button type="button" className="sp-link-btn" onClick={() => removeDuplicates(row)}>оставить последнюю</button>}
                            </span>
                          )}
                        </td>
                        <td data-label="Ед. изм.">{mixed ? p.units.map((u) => u.unit || '—').join(', ') : (p.unit || '—')}</td>
                        <td className="ui-money" data-label="Объём">
                          {mixed
                            ? p.units.map((u, i) => <div key={i}>{fmtVolume(u.volume)} {u.unit || ''}</div>)
                            : fmtVolume(p.volume)}
                        </td>
                        <td className="sp-input-cell" data-label="Цена с доставкой и НДС, ₽">
                          <SupplyMoneyCell
                            value={view.unitPrice}
                            derived={view.primary === 'total' && view.priced}
                            disabled={!editable}
                            cellId={`unit-${index}`}
                            label={`Цена за единицу: ${p.name}`}
                            title={view.primary === 'total' && view.priced ? 'Посчитано из суммы: сумма ÷ объём' : undefined}
                            invalid={draft?.status === 'error' && draft.mode === 'unit'}
                            onCommit={(raw) => commit(doc.name, row, 'unit', raw)}
                          />
                        </td>
                        <td className="sp-input-cell" data-label="Итого с НДС, ₽">
                          <SupplyMoneyCell
                            value={view.total}
                            derived={view.primary === 'unit' && view.priced}
                            disabled={totalDisabled}
                            cellId={`total-${index}`}
                            label={`Сумма: ${p.name}`}
                            title={mixed ? 'Сумму не ввести: у позиции разные единицы измерения'
                              : !(view.volume > 0) ? 'Сумму можно ввести только у позиции с объёмом'
                                : view.primary === 'unit' && view.priced ? 'Посчитано из цены: цена × объём' : undefined}
                            invalid={draft?.status === 'error' && draft.mode === 'total'}
                            onCommit={(raw) => commit(doc.name, row, 'total', raw)}
                          />
                        </td>
                        <td className="sp-state" data-label="">
                          <RowState
                            row={row}
                            flash={f}
                            editable={editable}
                            nameOf={nameOf}
                            onRetry={() => retryDraft(key)}
                            onDiscard={() => discardDraft(key)}
                            onConflict={() => setConflict({ key, intent: { mode: draft.mode, value: draft.value, estimateName: doc.name, position: p }, current: rate, position: p })}
                            onAcceptVolume={() => acceptVolume(row)}
                            onHistory={() => setHistoryFor({ position: p, rate, estimateName: doc.name, key })}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                {doc.positions.length > 0 && (
                  <tfoot>
                    <tr>
                      <td colSpan={4}>Итого по ВОР «{doc.name}» · расценено <span className="ui-num">{doc.priced}</span> из <span className="ui-num">{doc.positions.length}</span></td>
                      <td />
                      <td className="ui-money"><b>{formatAmount(doc.total)}</b></td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}

          {doc?.orphans.length > 0 && (
            <details className="sp-orphans">
              <summary>Цены без позиции в текущем ВОР ({doc.orphans.length})</summary>
              <p className="sp-muted">Наименования нет в позициях этого ВОР (ВОР обновился или цена загружена из Excel с другим написанием). Цены не удаляются сами.</p>
              <ul>
                {doc.orphans.map((r) => (
                  <li key={r.id}>
                    <span>{r.material_name}</span>
                    <span className="sp-muted">{r.unit || ''}</span>
                    <span className="ui-num">{formatAmount(rateUnitPrice(r))} ₽ за ед.</span>
                    <button type="button" className="sp-icon-btn" aria-label={`История цены: ${r.material_name}`}
                      onClick={() => setHistoryFor({ position: { name: r.material_name, unit: r.unit, volume: null }, rate: r, estimateName: doc.name, key: null })}>
                      <IconHistory size={16} />
                    </button>
                    {editable && (
                      <button type="button" className="sp-icon-btn" aria-label={`Удалить цену: ${r.material_name}`} onClick={() => removeOrphan(r)}>
                        <IconTrash size={16} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {importOpen && (
        <SupplyImportDialog
          mainId={mainId}
          files={files}
          sources={sources}
          onClose={() => setImportOpen(false)}
          onSaved={async ({ close }) => {
            try {
              const srcs = await loadData(mainId)
              if (!srcs.some((s) => s.estimate_name === activeDoc)) setActiveDoc(srcs[0]?.estimate_name ?? null)
            } catch (e) {
              setNotice(e.message)
            }
            if (close) setImportOpen(false)
          }}
        />
      )}
      {conflict && (
        <SupplyConflictDialog
          conflict={{ position: conflict.position, mine: conflict.intent.mode === 'clear' ? null : conflict.intent, current: conflict.current }}
          nameOf={nameOf}
          onClose={() => setConflict(null)}
          onKeepTheirs={() => { setDraft(conflict.key, null); setConflict(null) }}
          onWriteMine={() => { const c = conflict; setConflict(null); runSave(c.key, c.intent) }}
        />
      )}
      {historyFor && (
        <SupplyRateHistory
          mainId={mainId}
          target={historyFor}
          canRestore={editable && !!historyFor.key}
          onClose={() => setHistoryFor(null)}
          onRestore={(v) => {
            const h = historyFor
            setHistoryFor(null)
            const volume = h.position.units ? null : Number(h.position.volume)
            const intent = v.input === 'total' && v.total != null && volume > 0
              ? { mode: 'total', value: Number(v.total) }
              : { mode: 'unit', value: Number(v.price) }
            runSave(h.key, { ...intent, estimateName: h.estimateName, position: h.position })
          }}
        />
      )}
    </div>
  )
}

// Состояние строки — значки с подписью для диктора: сохраняется / сохранено / не сохранено / изменено другим /
// объём изменился; история цены.
function RowState({ row, flash, editable, nameOf, onRetry, onDiscard, onConflict, onAcceptVolume, onHistory }) {
  const { draft, rate, view } = row
  const items = []
  if (draft?.status === 'saving' || draft?.status === 'queued') {
    items.push(<span key="s" className="sp-st is-saving" role="status" aria-label="Сохраняется" title="Сохраняется"><IconClock size={16} /></span>)
  } else if (draft?.status === 'conflict') {
    items.push(
      <button key="c" type="button" className="sp-icon-btn is-warn" onClick={onConflict} aria-label="Цену изменил другой пользователь — выбрать значение" title="Цену изменил другой пользователь — выбрать значение">
        <IconAlert size={16} />
      </button>,
    )
  } else if (draft?.status === 'error') {
    const canRetry = draft.kind === 'retry' || draft.kind === 'stored' || draft.kind === 'error'
    items.push(
      <span key="e" className="sp-st-group">
        {canRetry && (
          <button type="button" className="sp-icon-btn is-error" onClick={onRetry} aria-label={`Не сохранено: ${draft.message}. Повторить`} title={`Не сохранено: ${draft.message}. Нажмите, чтобы повторить`}>
            <IconAlertCircle size={16} />
          </button>
        )}
        {!canRetry && <span className="sp-st is-error" title={draft.message} aria-label={`Не сохранено: ${draft.message}`}><IconAlertCircle size={16} /></span>}
        <button type="button" className="sp-icon-btn" onClick={onDiscard} aria-label="Отменить ввод" title="Отменить ввод">×</button>
      </span>,
    )
  } else if (flash?.kind === 'saved') {
    items.push(<span key="ok" className="sp-st is-saved" role="status" aria-label="Сохранено" title="Сохранено"><IconCheck size={16} /></span>)
  } else if (flash?.kind === 'remote') {
    const who = nameOf(flash.by) || 'другой пользователь'
    items.push(<span key="r" className="sp-st is-remote" title={`Изменил(а) ${who}${flash.at ? ` в ${fmtTime(flash.at)}` : ''}`} aria-label={`Изменил(а) ${who}`}>●</span>)
  }
  if (view.volumeChanged && !draft) {
    const text = `Объём изменился: было ${fmtVolume(rate.volume_at_input)}, стало ${fmtVolume(view.volume)}. Цена за единицу та же, сумма пересчитана`
    items.push(editable
      ? <button key="v" type="button" className="sp-icon-btn is-warn" onClick={onAcceptVolume} aria-label={`${text}. Принять`} title={`${text}. Нажмите, чтобы принять`}><IconAlert size={16} /></button>
      : <span key="v" className="sp-st is-warn" title={text} aria-label={text}><IconAlert size={16} /></span>)
  }
  if (rate || draft?.status === 'conflict') {
    items.push(
      <button key="h" type="button" className="sp-icon-btn" onClick={onHistory} aria-label={`История цены: ${row.p.name}`} title="История цены">
        <IconHistory size={16} />
      </button>,
    )
  }
  return <div className="sp-state-inner">{items}</div>
}
