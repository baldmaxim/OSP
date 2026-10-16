import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { useRole } from '../../contexts/RoleContext'
import SupplyMoneyCell from './SupplyMoneyCell'
import SupplyImportDialog from './SupplyImportDialog'
import SupplyConflictDialog from './SupplyConflictDialog'
import SupplyRateHistory from './SupplyRateHistory'
import { IconAlert, IconAlertCircle, IconCheck, IconClock, IconHistory, IconRefresh, IconTrash } from '../icons/ActionIcons'
import { IconFileSpreadsheet, IconUpload } from '../icons/BsmIcons'
import { IconSearch } from '../icons/ToolbarIcons'
import { IconChevronDown } from '../icons/TenderHubIcons'
import { fetchEmployees, employeesById } from '../../services/employees'
import { requestDownloadUrl } from '../../services/s3'
import {
  classifyError, clearRate, deleteSource, estimateSignatures, fetchVorWorkbook, loadChangeMarker, loadEstimateItems,
  loadPricingContext, loadRates, loadSources, loadVorFiles, renameEstimate, saveRate, saveSource,
} from '../../services/supplyPricing'
import { rateUnitPrice } from '../../utils/supplyRateHelpers'
import { formatAmount, parseAmount, roundMoney } from '../../utils/money'
import { buildSupplyPositions, positionsFromEstimate } from '../../utils/vorMaterials'
import { readMaterialsFromWorkbook } from '../../utils/vorMaterialsSheet'
import {
  estimateVersion, fileVersion, identicalTargets, planCleanup, planFileImports, planTabImports,
} from '../../utils/supplyAutoImport'
import './SupplyPricing.css'
// Рабочий стиль (docs/UI_GUIDELINES.md): корень панели — .ui-work, и в карточке тендера тоже.
import '../../styles/fonts.css'
import '../../styles/workUi.css'

// Расценка материалов ВОР снабжением (миграция 20261020) — одна таблица в двух местах: вкладка «Расценки
// снабжения» карточки тендера (тендерный отдел) и страница /tenders/materials/:id/pricing (снабжение, которому
// карточка с участниками и КП закрыта).
//
// Позиции загружаются сами, без кнопки: сначала лист «Материалы» файлов ВОР из «ВОРов и РД» основного
// тендера, если ни один не дал позиций — вкладка «ВОР» карточки (utils/supplyAutoImport). Записывать может
// только тот, у кого право правки, — у остальных подсказка, что ВОР загрузится при открытии снабжением.
// Не загрузилось — плашка с причиной и что сделать. Все ВОР — в одной таблице, каждый со своей строкой-шапкой.
//
// Цены — tender_vor_supply_rates основного тендера: введённое сразу видно в карточке и в «Сравнении КП», в
// реестре «Расценки от снабжения СУ-10» — после его пересчёта (до 10 минут). Сохранение — по Enter / уходу из
// поля, с версией строки (чужая правка не перетирается молча); черновики — в localStorage до подтверждения;
// чужие правки — опросом журнала раз в 20 с. Цена позиции подставляется в такие же позиции других ВОР, где
// цены ещё нет.

const POLL_MS = 20000
const RETRY_DELAYS = [5000, 15000, 30000, 60000]
const SAVED_FLASH_MS = 2000
const REMOTE_FLASH_MS = 6000
const VOLUME_FMT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 })
const fmtVolume = (v) => (v == null || v === '' ? '—' : VOLUME_FMT.format(Number(v)))
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
const posKey = (estimateName, k) => `${estimateName}∣${k}`
const draftsKey = (mainId) => `supply-pricing-drafts:${mainId}`
const ACTIVE_STATUSES = new Set(['saving', 'queued', 'error', 'conflict'])

// Почему ВОР не загрузился и что сделать.
const PROBLEM_TEXT = {
  no_sheet: (p) => `в файле нет листа «Материалы»${p.sheetNames?.length ? ` (листы: ${p.sheetNames.join(', ')})` : ''}. `
    + 'Добавьте лист «Материалы» с колонками «Наименование», «Ед. изм.», «Объём» и загрузите файл в «ВОРы и РД» заново — или укажите лист вручную.',
  no_header: (p) => `на листе «${p.sheetName}» не нашли шапку: в первых 30 строках нужны колонки «Наименование» и «Объём» (или «Кол-во»). Укажите колонки вручную.`,
  empty: (p) => `на листе «${p.sheetName}» нет позиций: все строки — разделы, итоги или пустые. Проверьте колонки.`,
  error: (p) => `файл не открылся (${p.message}). Повторите позже; если не поможет — загрузите файл в «ВОРы и РД» заново.`,
}

// Позиции из базы уже сгруппированы по ключу; на случай совпадения ключей — склеиваем в одну позицию.
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

// Расценка позиции по ключу «ВОР∣ключ наименования»: самая свежая (дубли из Excel — ниже).
function rateIn(list, key) {
  const [estimateName, k] = key.split('∣')
  const own = list.filter((r) => r.estimate_name === estimateName && r.material_key === k)
  return own.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0] || null
}

const loadStoredDrafts = (mainId) => {
  try { return JSON.parse(localStorage.getItem(draftsKey(mainId)) || '{}') || {} } catch { return {} }
}
const storeDrafts = (mainId, drafts) => {
  try {
    const keep = {}
    for (const [k, d] of Object.entries(drafts)) {
      if (ACTIVE_STATUSES.has(d.status) && !d.auto) keep[k] = { mode: d.mode, value: d.value, estimateName: d.estimateName, at: d.at }
    }
    if (Object.keys(keep).length) localStorage.setItem(draftsKey(mainId), JSON.stringify(keep))
    else localStorage.removeItem(draftsKey(mainId))
  } catch { /* приватный режим — черновик только в памяти */ }
}

// ctx — готовый контекст (страница уже загрузила его для шапки) или tenderId — загрузим сами (карточка).
// estimateItems — строки вкладки «ВОР», если они уже есть у карточки. onRatesChange — карточке, чтобы
// «Сравнение КП» и выгрузка видели новые цены. excelImport — { onImport(estimateName) }: загрузка цен из Excel
// (есть только в карточке). refreshToken — карточка увеличивает его после своей записи (Excel, удаление).
export default function SupplyPricingPanel({ ctx: ctxProp = null, tenderId = null, estimateItems: itemsProp = null, onRatesChange, excelImport = null, refreshToken = 0, variant = 'page' }) {
  const { canEdit, user } = useRole()
  const canEditRole = canEdit('tenders') || canEdit('tenders_materials')
  const myId = user?.id || null

  const [ctx, setCtx] = useState(ctxProp)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [missing, setMissing] = useState(false)
  const [files, setFiles] = useState([])
  const [sources, setSources] = useState([])
  const [rates, setRates] = useState([])
  const [loadedItems, setLoadedItems] = useState(null)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [drafts, setDrafts] = useState({})
  const [flash, setFlash] = useState({}) // key → { kind: 'saved' | 'remote' | 'auto', by, at, from }
  const [conflict, setConflict] = useState(null)
  const [historyFor, setHistoryFor] = useState(null)
  const [mappingFile, setMappingFile] = useState(null)
  const [problems, setProblems] = useState([])
  const [importing, setImporting] = useState(null) // { label, done, total }
  const [employees, setEmployees] = useState(() => new Map())
  const [notice, setNotice] = useState('')
  const [info, setInfo] = useState('')
  const [bindTarget, setBindTarget] = useState({})

  const mainId = ctx?.mainId || null
  const editable = canEditRole && !!ctx && !ctx.locked && !missing
  const ratesRef = useRef(rates)
  const draftsRef = useRef(drafts)
  const docViewsRef = useRef([])
  const inflight = useRef(new Set())
  const queued = useRef(new Map())
  const retryTimers = useRef(new Map())
  const recentlyDeleted = useRef(new Map())
  const recentLocal = useRef(new Map())
  const markerRef = useRef(null)
  const runSaveRef = useRef(null)
  const failedFiles = useRef(new Map())
  const autoBusy = useRef(false)
  const autoKey = useRef('')
  const autoRerun = useRef(false)
  const [autoTick, setAutoTick] = useState(0)
  ratesRef.current = rates
  draftsRef.current = drafts

  // Карточке — свежие цены для «Сравнения КП» и выгрузки.
  const onRatesChangeRef = useRef(onRatesChange)
  onRatesChangeRef.current = onRatesChange
  useEffect(() => { if (!loading && !missing) onRatesChangeRef.current?.(rates) }, [rates, loading, missing])

  // ── Загрузка ──────────────────────────────────────────────────────────────────────────────────────
  const loadData = useCallback(async (id) => {
    const [vorFiles, srcs, rateRows, marker] = await Promise.all([loadVorFiles(id), loadSources(id), loadRates(id), loadChangeMarker(id)])
    markerRef.current = marker
    setFiles(vorFiles)
    setSources(srcs)
    setRates(rateRows)
    return srcs
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadError('')
    setMissing(false)
    ;(async () => {
      try {
        const c = ctxProp || await loadPricingContext(tenderId)
        if (!alive) return
        setCtx(c)
        if (!c) return
        try {
          await loadData(c.mainId)
          if (!alive) return
          const stored = loadStoredDrafts(c.mainId)
          if (Object.keys(stored).length) {
            setDrafts(Object.fromEntries(Object.entries(stored).map(([k, d]) => [k, {
              ...d, status: 'error', kind: 'stored', message: 'Не сохранено при прошлом открытии — повторите или отмените ввод',
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
  }, [ctxProp, tenderId, loadData])

  // Строки вкладки «ВОР»: имена ВОР карточки, их версии и позиции на случай, если файлов ВОР нет.
  useEffect(() => {
    if (itemsProp || !mainId || missing) return undefined
    let alive = true
    loadEstimateItems(mainId).then((items) => { if (alive) setLoadedItems(items) }).catch(() => { if (alive) setLoadedItems([]) })
    return () => { alive = false }
  }, [itemsProp, mainId, missing])
  const estimateItems = itemsProp || loadedItems
  const estimate = useMemo(() => {
    if (!estimateItems) return null
    const docs = positionsFromEstimate(estimateItems)
    return { docs, signatures: estimateSignatures(estimateItems), names: [...docs.keys()] }
  }, [estimateItems])

  // Карточка записала сама (Excel, удаление) — перечитать.
  const firstToken = useRef(refreshToken)
  useEffect(() => {
    if (refreshToken === firstToken.current || !mainId) return
    loadData(mainId).catch((e) => setNotice(e.message))
  }, [refreshToken, mainId, loadData])

  // ФИО тех, кто менял цены и загружал ВОР (в строках расценок — только id).
  useEffect(() => {
    if (!mainId) return
    fetchEmployees().then((list) => setEmployees(employeesById(list))).catch(() => {})
  }, [mainId])
  const nameOf = useCallback((userId) => {
    if (!userId) return null
    const e = employees.get(userId)
    return e?.display_name || e?.full_name || null
  }, [employees])

  useEffect(() => { if (mainId) storeDrafts(mainId, drafts) }, [mainId, drafts])
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (Object.values(draftsRef.current).some((d) => ACTIVE_STATUSES.has(d.status) && !d.auto)) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])
  useEffect(() => () => { for (const t of retryTimers.current.values()) clearTimeout(t) }, [])

  // ── Автозагрузка позиций ВОР ──────────────────────────────────────────────────────────────────────
  const runAutoImport = useCallback(async () => {
    if (autoBusy.current || !mainId || !estimate) return
    autoBusy.current = true
    const found = []
    let changed = false
    try {
      const cardNames = estimate.names
      const { jobs, skipped } = planFileImports(files, sources, cardNames)
      const fresh = jobs.filter((j) => !failedFiles.current.has(j.doc.id))
      for (const j of jobs) if (failedFiles.current.has(j.doc.id)) found.push(failedFiles.current.get(j.doc.id))
      let fileSourceCreated = sources.some((s) => s.source === 'vor_file')
      for (const [i, job] of fresh.entries()) {
        setImporting({ label: `файл «${job.doc.file_name}»`, done: i, total: fresh.length })
        try {
          const wb = await fetchVorWorkbook(job.doc)
          let result = readMaterialsFromWorkbook(wb)
          const saved = job.existing?.column_map
          if (result.error === 'no_header' && saved?.columns && wb.Sheets[saved.sheetName]) result = readMaterialsFromWorkbook(wb, saved)
          const positions = result.error ? [] : buildSupplyPositions(result.rows)
          if (result.error || !positions.length) {
            const p = { doc: job.doc, kind: result.error || 'empty', sheetNames: result.sheetNames || wb.SheetNames, sheetName: result.sheetName }
            failedFiles.current.set(job.doc.id, p)
            found.push(p)
            continue
          }
          await saveSource({
            existing: job.existing, mainId, estimateName: job.name, source: 'vor_file', doc: job.doc,
            sheetName: result.sheetName, columnMap: result.map, sourceVersion: fileVersion(job.doc), positions,
          })
          changed = true
          fileSourceCreated = true
        } catch (e) {
          // Одновременно загрузил другой — его список уже в базе.
          if (e.kind === 'conflict') { changed = true; continue }
          const p = { doc: job.doc, kind: 'error', message: e.message }
          if (e.kind !== 'retry') failedFiles.current.set(job.doc.id, p)
          found.push(p)
        }
      }
      for (const s of skipped) found.push({ doc: s.doc, kind: 'older', name: s.name })
      // Файлов с листом «Материалы» нет — вкладка «ВОР» карточки.
      if (!fileSourceCreated) {
        const tabJobs = planTabImports(sources, estimate.docs, estimate.signatures)
        for (const [i, job] of tabJobs.entries()) {
          setImporting({ label: `ВОР «${job.name}» из вкладки «ВОР»`, done: i, total: tabJobs.length })
          try {
            await saveSource({ existing: job.existing, mainId, estimateName: job.name, source: 'vor_tab', doc: null, sourceVersion: job.version, positions: job.positions })
            changed = true
          } catch (e) {
            if (e.kind === 'conflict') { changed = true; continue }
            found.push({ doc: null, name: job.name, kind: 'error', message: e.message })
          }
        }
      }
      let current = sources
      if (changed) current = await loadSources(mainId)
      // Пустые устаревшие списки (из вкладки «ВОР», когда появились файлы; от удалённого файла) — убрать.
      for (const s of planCleanup(current, ratesRef.current)) {
        try { await deleteSource(s); changed = true } catch { /* в следующий раз */ }
      }
      if (changed) setSources(await loadSources(mainId))
    } catch (e) {
      found.push({ doc: null, kind: 'error', message: e.message })
    } finally {
      setProblems(found)
      setImporting(null)
      autoBusy.current = false
      // Пока шёл прогон, пришли новые файлы или списки — ещё один прогон.
      if (autoRerun.current) {
        autoRerun.current = false
        autoKey.current = ''
        setAutoTick((t) => t + 1)
      }
    }
  }, [mainId, estimate, files, sources])

  // Запуск — когда изменились файлы, списки позиций или ВОР карточки; без права правки — не пишем.
  useEffect(() => {
    if (loading || missing || !editable || !estimate) return
    const key = JSON.stringify([files.map((f) => f.id), sources.map((s) => `${s.id}:${s.row_version}`), [...estimate.signatures.entries()]])
    if (autoKey.current === key) return
    if (autoBusy.current) { autoRerun.current = true; return }
    autoKey.current = key
    runAutoImport()
  }, [loading, missing, editable, estimate, files, sources, runAutoImport, autoTick])

  const retryFile = (doc) => {
    failedFiles.current.delete(doc.id)
    autoKey.current = ''
    runAutoImport()
  }

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
    let priced = 0
    let total = 0
    for (const p of positions) {
      const rate = ratesByKey.get(posKey(s.estimate_name, p.k))?.[0]
      if (!rate) continue
      priced += 1
      total += rateTotal(rate, p) || 0
    }
    return { source: s, name: s.estimate_name, positions, priced, total: roundMoney(total) }
  }), [sources, ratesByKey])
  docViewsRef.current = docViews

  const grand = useMemo(() => docViews.reduce((a, d) => ({
    positions: a.positions + d.positions.length, priced: a.priced + d.priced, total: roundMoney(a.total + d.total),
  }), { positions: 0, priced: 0, total: 0 }), [docViews])

  // Цены без позиции: наименования нет ни в одном списке позиций этого ВОР (ВОР обновился, Excel с другим
  // написанием, ВОР без списка позиций).
  const orphans = useMemo(() => {
    const keys = new Set(docViews.flatMap((d) => d.positions.map((p) => posKey(d.name, p.k))))
    return rates.filter((r) => !keys.has(posKey(r.estimate_name, r.material_key)))
  }, [docViews, rates])

  // Что изменилось у источника: файл удалён, ВОР карточки перезагружен; имя ВОР не как в карточке.
  const docNotes = useMemo(() => {
    const out = new Map()
    const fileIds = new Set(files.map((f) => f.id))
    const cardNames = estimate?.names || []
    for (const s of sources) {
      const notes = []
      if (s.source === 'vor_file') {
        if (!s.s3_document_id || !fileIds.has(s.s3_document_id)) notes.push({ kind: 'stale', text: 'Файл удалён из «ВОРов и РД» — позиции остались от него.' })
        if (cardNames.length && !cardNames.includes(s.estimate_name)) notes.push({ kind: 'bind', text: `Во вкладке «ВОР» карточки нет ВОР «${s.estimate_name}» — «Сравнение КП» эти цены не сопоставит.` })
      } else if (estimate) {
        const sig = estimate.signatures.get(s.estimate_name)
        if (!sig) notes.push({ kind: 'stale', text: 'ВОР удалён из вкладки «ВОР» карточки — позиции остались от него.' })
        else if (s.source_version && estimateVersion(sig) !== s.source_version && !editable) notes.push({ kind: 'stale', text: 'ВОР в карточке перезагружен — позиции обновятся при открытии снабжением или тендерным отделом.' })
      }
      if (notes.length) out.set(s.estimate_name, notes)
    }
    return out
  }, [sources, files, estimate, editable])

  // Без права правки автозагрузки нет: какие файлы ещё не загружены.
  const pendingForViewer = useMemo(() => {
    if (editable || !estimate) return []
    return planFileImports(files, sources, estimate.names).jobs
  }, [editable, estimate, files, sources])

  const sections = useMemo(() => {
    const q = search.trim().toLowerCase()
    let gi = 0
    return docViews.map((d) => {
      const rows = d.positions.map((p, index) => {
        const key = posKey(d.name, p.k)
        const list = ratesByKey.get(key) || []
        const rate = list[0] || null
        const draft = drafts[key] || null
        return { p, index, key, rate, duplicates: list.slice(1), draft, view: rowView(p, rate, draft), doc: d.name }
      }).filter((r) => {
        if (q && !r.p.name.toLowerCase().includes(q)) return false
        if (filter === 'unpriced') return !r.view.priced
        if (filter === 'priced') return r.view.priced
        return true
      })
      const open = !collapsed.has(d.name)
      for (const r of rows) r.gi = open ? gi++ : -1
      return { doc: d, rows, open }
    })
  }, [docViews, ratesByKey, drafts, search, filter, collapsed])

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

  const applyRow = useCallback((oldRate, row) => {
    setRates((prev) => {
      if (oldRate && !row) {
        recentlyDeleted.current.set(oldRate.id, Date.now())
        return prev.filter((r) => r.id !== oldRate.id)
      }
      if (row) {
        recentLocal.current.set(row.id, Date.now())
        const i = prev.findIndex((r) => r.id === row.id)
        return i === -1 ? [...prev, row] : prev.map((r) => (r.id === row.id ? row : r))
      }
      return prev
    })
  }, [])

  const reloadContext = useCallback(async () => {
    try {
      const c = await loadPricingContext(ctx?.opened?.id || tenderId)
      if (c) setCtx(c)
    } catch { /* останется прежнее */ }
  }, [ctx, tenderId])

  // Цену позиции — в такие же позиции других ВОР, где цены ещё нет (решение пользователя 16.10).
  const fillIdentical = useCallback((estimateName, position, row) => {
    const price = roundMoney(rateUnitPrice(row))
    if (!(price > 0)) return
    const isPriced = (name, k) => !!rateIn(ratesRef.current, posKey(name, k)) || !!draftsRef.current[posKey(name, k)]
    const targets = identicalTargets(docViewsRef.current, estimateName, position, isPriced)
    for (const t of targets) {
      runSaveRef.current(posKey(t.name, t.position.k), { mode: 'unit', value: price, estimateName: t.name, position: t.position, auto: true, from: estimateName })
    }
    if (targets.length) {
      const docs = [...new Set(targets.map((t) => `«${t.name}»`))].join(', ')
      setInfo(`Цена «${position.name}» подставлена в такие же позиции: ВОР ${docs}.`)
    }
  }, [])

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
    const rate = rateIn(ratesRef.current, key)
    try {
      // Подстановка в одинаковую позицию: пока шла запись, цену там поставил кто-то — его не трогаем.
      if (intent.auto && rate) { setDraft(key, null); return }
      const res = intent.mode === 'clear'
        ? (rate ? await clearRate(rate) : { status: 'ok', row: null })
        : await saveRate({ rate, mainId, estimateName: intent.estimateName, position: intent.position, mode: intent.mode, value: intent.value })
      if (res.status === 'ok') {
        applyRow(rate, res.row)
        if (!queued.current.has(key)) setDraft(key, null)
        flashRow(key, intent.auto ? { kind: 'auto', from: intent.from } : { kind: 'saved' }, intent.auto ? REMOTE_FLASH_MS : SAVED_FLASH_MS)
        if (!intent.auto && res.row) fillIdentical(intent.estimateName, intent.position, res.row)
      } else if (intent.auto) {
        if (res.current) applyRow(null, res.current)
        setDraft(key, null)
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
          if (d?.status === 'error' && d.kind === 'retry') {
            runSaveRef.current(key, { mode: d.mode, value: d.value, estimateName: d.estimateName, position: d.position, auto: d.auto, from: d.from })
          }
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
  }, [mainId, applyRow, setDraft, flashRow, reloadContext, fillIdentical])
  runSaveRef.current = runSave

  const commit = useCallback((row, field, raw) => {
    const { p, key, rate, view, doc } = row
    const value = parseAmount(raw)
    const intentBase = { estimateName: doc, position: p }
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

  const acceptVolume = (row) => {
    const { p, key, rate, view, doc } = row
    if (!rate) return
    if (rate.price_input === 'total' && view.volume > 0) {
      runSave(key, { estimateName: doc, position: p, mode: 'total', value: roundMoney(rateUnitPrice(rate) * view.volume) })
    } else {
      runSave(key, { estimateName: doc, position: p, mode: 'unit', value: Number(rate.input_value ?? rate.supply_price) })
    }
  }

  const removeDuplicates = async (row) => {
    for (const r of row.duplicates) {
      try { await clearRate(r); applyRow(r, null) } catch (e) { setNotice(e.message); break }
    }
  }

  const removeOrphan = async (rate) => {
    if (!window.confirm(`Удалить цену «${rate.material_name}»? Позиции с таким наименованием в ВОР «${rate.estimate_name}» нет. Удаление записывается в журнал.`)) return
    try {
      const res = await clearRate(rate)
      if (res.status === 'ok') applyRow(rate, null)
      else { if (res.current) applyRow(null, res.current); setNotice('Цену уже изменил другой пользователь — проверьте.') }
    } catch (e) {
      setNotice(e.message)
    }
  }

  // Очистить все цены ВОР (была кнопка «Очистить» во вкладке карточки). Журнал хранит их — можно вернуть.
  const clearDoc = async (d) => {
    const own = rates.filter((r) => r.estimate_name === d.name)
    if (!own.length) return
    const fromSite = own.filter((r) => r.price_input === 'unit' || r.price_input === 'total').length
    if (!window.confirm(`Удалить все цены снабжения ВОР «${d.name}» (${own.length})?${fromSite ? ` Из них введено на сайте: ${fromSite}.` : ''}\n\nУдаление записывается в журнал — цену можно вернуть из истории.`)) return
    for (const r of own) {
      try { const res = await clearRate(r); if (res.status === 'ok') applyRow(r, null) } catch (e) { setNotice(e.message); break }
    }
  }

  // Имя ВОР не как в карточке — перенести цены и позиции на ВОР карточки (supply_estimate_rename).
  const bindDoc = async (from) => {
    const to = bindTarget[from]
    if (!to) return
    try {
      await renameEstimate(mainId, from, to)
      await loadData(mainId)
    } catch (e) {
      setNotice(`Не удалось привязать: ${e.message}`)
    }
  }

  // ── Синхронизация ─────────────────────────────────────────────────────────────────────────────────
  const refreshFromServer = useCallback(async () => {
    if (!mainId) return
    const [srcs, rateRows, vorFiles] = await Promise.all([loadSources(mainId), loadRates(mainId), loadVorFiles(mainId)])
    const now = Date.now()
    for (const [id, at] of recentlyDeleted.current) if (now - at > 60000) recentlyDeleted.current.delete(id)
    for (const [id, at] of recentLocal.current) if (now - at > 60000) recentLocal.current.delete(id)
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
    setFiles(vorFiles)
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
    // Вернулись на вкладку — заодно проверить, не добавили ли файлы ВОР.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      tick()
      loadVorFiles(mainId).then(setFiles).catch(() => {})
    }
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

  const downloadFile = async (fileId) => {
    const f = files.find((x) => x.id === fileId)
    if (!f) return
    try {
      const { presigned_url } = await requestDownloadUrl(f.s3_key, { fileName: f.file_name, download: true })
      window.location.assign(presigned_url)
    } catch (e) {
      setNotice(`Файл не скачался: ${e.message}`)
    }
  }

  const toggleDoc = (name) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(name)) next.delete(name); else next.add(name)
    return next
  })

  // ── Отрисовка ─────────────────────────────────────────────────────────────────────────────────────
  if (loading) return <div className="sp-loading">Загрузка расценки…</div>
  if (loadError) return <p className="sp-error-text">{loadError}</p>
  if (!ctx) return <p className="sp-error-text">Тендер не найден.</p>

  const pending = Object.values(drafts).filter((d) => ACTIVE_STATUSES.has(d.status) && !d.auto).length
  const readOnlyReason = ctx.locked
    ? 'Тендер на материалы завершён — расценки только для чтения. Чтобы изменить, верните тендеру на материалы прежний статус.'
    : !canEditRole ? 'Только просмотр: вводить цены могут снабжение и тендерный отдел (право правки раздела).' : ''
  const fromTab = docViews.length > 0 && docViews.every((d) => d.source.source === 'vor_tab')

  return (
    <div className={`ui-work sp-panel sp-panel-${variant}`}>
      {missing && (
        <div className="sp-banner is-warn" role="status">
          <IconAlert size={16} />
          <span>Расценка на сайте ещё не включена: на сервере не применено обновление базы. Сообщите администратору.</span>
        </div>
      )}
      {readOnlyReason && !missing && <div className="sp-banner" role="status"><IconAlertCircle size={16} /><span>{readOnlyReason}</span></div>}
      {ctx.orphan && <div className="sp-banner is-warn"><IconAlert size={16} /><span>Тендер на материалы не связан с основным тендером — файлы ВОР ищутся у него самого.</span></div>}
      {importing && (
        <div className="sp-banner" role="status">
          <IconClock size={16} />
          <span>Загружаем позиции ВОР: {importing.label}{importing.total > 1 ? ` (${importing.done + 1} из ${importing.total})` : ''}…</span>
        </div>
      )}
      {problems.map((p, i) => (
        <div key={`${p.doc?.id || p.name}-${i}`} className="sp-banner is-warn sp-problem" role="alert">
          <IconAlert size={16} />
          <span>
            {p.kind === 'older'
              ? <>Файл «{p.doc.file_name}» не загружен: есть более новый файл того же ВОР «{p.name}».</>
              : <>ВОР{p.doc ? <> из файла «{p.doc.file_name}»</> : p.name ? <> «{p.name}»</> : ''} не загрузился: {(PROBLEM_TEXT[p.kind] || PROBLEM_TEXT.error)(p)}</>}
          </span>
          {editable && p.doc && ['no_sheet', 'no_header', 'empty'].includes(p.kind) && (
            <button type="button" className="sp-link-btn" onClick={() => setMappingFile(p.doc)}>Указать лист и колонки</button>
          )}
          {editable && p.doc && p.kind === 'error' && <button type="button" className="sp-link-btn" onClick={() => retryFile(p.doc)}>Повторить</button>}
        </div>
      ))}
      {pendingForViewer.length > 0 && (
        <div className="sp-banner" role="status">
          <IconRefresh size={16} />
          <span>Файлы ВОР ещё не загружены в расценку: {pendingForViewer.map((j) => `«${j.doc.file_name}»`).join(', ')}. Загрузятся сами, когда тендер откроет снабжение или тендерный отдел.</span>
        </div>
      )}
      {notice && (
        <div className="sp-banner is-warn" role="alert">
          <IconAlert size={16} /><span>{notice}</span>
          <button type="button" className="sp-link-btn" onClick={() => setNotice('')}>Скрыть</button>
        </div>
      )}
      {info && (
        <div className="sp-banner is-info" role="status">
          <IconCheck size={16} /><span>{info}</span>
          <button type="button" className="sp-link-btn" onClick={() => setInfo('')}>Скрыть</button>
        </div>
      )}
      {pending > 0 && (
        <div className="sp-banner is-warn" role="status">
          <IconClock size={16} /><span>Не сохранено значений: {pending}. Не закрывайте страницу, пока они не сохранятся.</span>
        </div>
      )}
      {fromTab && (
        <p className="sp-muted sp-source-hint">Файлов ВОР с листом «Материалы» в «ВОРах и РД» нет — позиции взяты из вкладки «ВОР» карточки тендера.</p>
      )}

      {!missing && docViews.length === 0 && !importing && (
        <div className="sp-empty">
          <p>Позиций для расценки нет.</p>
          <p className="sp-muted">
            {files.length
              ? 'Файлы ВОР в «ВОРах и РД» есть, но позиции из них не загрузились — причина выше.'
              : 'В «ВОРах и РД» тендера нет файлов ВОР в Excel, и во вкладке «ВОР» карточки нет материалов.'}
          </p>
        </div>
      )}

      {!missing && docViews.length > 0 && (
        <>
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
            {docViews.length > 1 && (
              <button type="button" className="sp-link-btn" onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(docViews.map((d) => d.name)))}>
                {collapsed.size ? 'Развернуть все ВОР' : 'Свернуть все ВОР'}
              </button>
            )}
            <div className="sp-toolbar-right">
              <span className="sp-summary-inline" aria-live="polite">Расценено <b className="ui-num">{grand.priced}</b> из <b className="ui-num">{grand.positions}</b> · Итого <b className="ui-num">{formatAmount(grand.total)} ₽</b></span>
              <span className="sp-muted sp-registry-hint">В реестре «Расценки от снабжения СУ-10» — в течение 10 минут</span>
              <button type="button" className="btn-secondary" onClick={exportExcel}><IconFileSpreadsheet size={16} /> Скачать Excel</button>
            </div>
          </div>

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
              {sections.map(({ doc: d, rows, open }) => {
                if (!rows.length && (search || filter !== 'all')) return null
                const notes = docNotes.get(d.name) || []
                const s = d.source
                const complete = d.positions.length > 0 && d.priced === d.positions.length
                const hasRates = rates.some((r) => r.estimate_name === d.name)
                return (
                  <tbody key={d.name} className="sp-section">
                    <tr className="sp-section-head">
                      <td colSpan={7}>
                        <div className="sp-section-line">
                          <button type="button" className={`sp-section-toggle${open ? ' is-open' : ''}`} onClick={() => toggleDoc(d.name)} aria-expanded={open}
                            aria-label={`${open ? 'Свернуть' : 'Развернуть'} ВОР «${d.name}»`}>
                            <IconChevronDown size={16} />
                          </button>
                          <span className="sp-section-name">ВОР «{d.name}»</span>
                          {complete && <span className="sp-section-done" title="Все позиции расценены"><IconCheck size={14} /> расценён</span>}
                          <span className="sp-section-count ui-num">расценено {d.priced} из {d.positions.length}</span>
                          <span className="sp-section-sum ui-num">{formatAmount(d.total)} ₽</span>
                        </div>
                        <div className="sp-section-meta">
                          {s.source === 'vor_file'
                            ? <>файл «{s.file_name || 'удалён'}», лист «{s.sheet_name || 'Материалы'}»</>
                            : <>вкладка «ВОР» карточки тендера</>}
                          <span> · загружено {fmtTime(s.parsed_at)}{nameOf(s.parsed_by) ? `, ${nameOf(s.parsed_by)}` : ''}</span>
                          {s.source === 'vor_file' && s.s3_document_id && files.some((f) => f.id === s.s3_document_id) && (
                            <>
                              <button type="button" className="sp-link-btn" onClick={() => downloadFile(s.s3_document_id)}>скачать файл</button>
                              {editable && (
                                <button type="button" className="sp-link-btn" onClick={() => setMappingFile(files.find((f) => f.id === s.s3_document_id))}>колонки листа</button>
                              )}
                            </>
                          )}
                          {excelImport && editable && (
                            <button type="button" className="sp-link-btn" onClick={() => excelImport.onImport(d.name)}>
                              <IconUpload size={14} /> загрузить цены из Excel
                            </button>
                          )}
                          {editable && hasRates && (
                            <button type="button" className="sp-link-btn is-danger" onClick={() => clearDoc(d)}>очистить цены</button>
                          )}
                        </div>
                        {notes.map((n, i) => (
                          <div key={i} className="sp-section-note">
                            <IconAlert size={14} /> {n.text}
                            {n.kind === 'bind' && editable && (
                              <span className="sp-bind">
                                <select value={bindTarget[d.name] || ''} onChange={(e) => setBindTarget((prev) => ({ ...prev, [d.name]: e.target.value }))}
                                  aria-label={`ВОР карточки для «${d.name}»`}>
                                  <option value="">ВОР карточки…</option>
                                  {(estimate?.names || []).map((n2) => <option key={n2} value={n2}>{n2}</option>)}
                                </select>
                                <button type="button" className="sp-link-btn" disabled={!bindTarget[d.name]} onClick={() => bindDoc(d.name)}>Привязать</button>
                              </span>
                            )}
                          </div>
                        ))}
                      </td>
                    </tr>
                    {open && rows.length === 0 && (
                      <tr><td colSpan={7} className="no-data">В этом ВОР нет позиций</td></tr>
                    )}
                    {open && rows.map((row) => (
                      <PriceRow
                        key={row.key}
                        row={row}
                        flash={flash[row.key]}
                        editable={editable}
                        nameOf={nameOf}
                        onCommit={commit}
                        onRetry={() => retryDraft(row.key)}
                        onDiscard={() => discardDraft(row.key)}
                        onConflict={() => setConflict({ key: row.key, intent: { mode: row.draft.mode, value: row.draft.value, estimateName: row.doc, position: row.p }, current: row.rate, position: row.p })}
                        onAcceptVolume={() => acceptVolume(row)}
                        onHistory={() => setHistoryFor({ position: row.p, rate: row.rate, estimateName: row.doc, key: row.key })}
                        onRemoveDuplicates={() => removeDuplicates(row)}
                      />
                    ))}
                  </tbody>
                )
              })}
              <tfoot>
                <tr>
                  <td colSpan={4}>Итого{docViews.length > 1 ? ` по ${docViews.length} ВОР` : ''} · расценено <span className="ui-num">{grand.priced}</span> из <span className="ui-num">{grand.positions}</span></td>
                  <td />
                  <td className="ui-money"><b>{formatAmount(grand.total)}</b></td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {orphans.length > 0 && (
        <details className="sp-orphans">
          <summary>Цены без позиции в ВОР ({orphans.length})</summary>
          <p className="sp-muted">Наименования нет в позициях своего ВОР (ВОР обновился или цена загружена из Excel с другим написанием). Цены не удаляются сами.</p>
          <ul>
            {orphans.map((r) => (
              <li key={r.id}>
                <span>{r.material_name} <span className="sp-muted">· ВОР «{r.estimate_name}»</span></span>
                <span className="sp-muted">{r.unit || ''}</span>
                <span className="ui-num">{formatAmount(rateUnitPrice(r))} ₽ за ед.</span>
                <button type="button" className="sp-icon-btn" aria-label={`История цены: ${r.material_name}`}
                  onClick={() => setHistoryFor({ position: { name: r.material_name, unit: r.unit, volume: null }, rate: r, estimateName: r.estimate_name, key: null })}>
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

      {mappingFile && (
        <SupplyImportDialog
          mainId={mainId}
          files={[mappingFile]}
          sources={sources}
          onClose={() => setMappingFile(null)}
          onSaved={async ({ close }) => {
            failedFiles.current.delete(mappingFile.id)
            try { await loadData(mainId) } catch (e) { setNotice(e.message) }
            setProblems((prev) => prev.filter((p) => p.doc?.id !== mappingFile.id))
            if (close) setMappingFile(null)
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

function PriceRow({ row, flash, editable, nameOf, onCommit, onRetry, onDiscard, onConflict, onAcceptVolume, onHistory, onRemoveDuplicates }) {
  const { p, draft, view, index, gi } = row
  const mixed = !!p.units
  const totalDisabled = !editable || mixed || !(view.volume > 0)
  return (
    <tr
      className={[
        !view.priced && 'is-unpriced',
        (flash?.kind === 'remote' || flash?.kind === 'auto') && 'is-remote',
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
            {editable && <button type="button" className="sp-link-btn" onClick={onRemoveDuplicates}>оставить последнюю</button>}
          </span>
        )}
      </td>
      <td data-label="Ед. изм.">{mixed ? p.units.map((u) => u.unit || '—').join(', ') : (p.unit || '—')}</td>
      <td className="ui-money" data-label="Объём">
        {mixed ? p.units.map((u, i) => <div key={i}>{fmtVolume(u.volume)} {u.unit || ''}</div>) : fmtVolume(p.volume)}
      </td>
      <td className="sp-input-cell" data-label="Цена с доставкой и НДС, ₽">
        <SupplyMoneyCell
          value={view.unitPrice}
          derived={view.primary === 'total' && view.priced}
          disabled={!editable}
          cellId={`unit-${gi}`}
          label={`Цена за единицу: ${p.name} (ВОР «${row.doc}»)`}
          title={view.primary === 'total' && view.priced ? 'Посчитано из суммы: сумма ÷ объём' : undefined}
          invalid={draft?.status === 'error' && draft.mode === 'unit'}
          onCommit={(raw) => onCommit(row, 'unit', raw)}
        />
      </td>
      <td className="sp-input-cell" data-label="Итого с НДС, ₽">
        <SupplyMoneyCell
          value={view.total}
          derived={view.primary === 'unit' && view.priced}
          disabled={totalDisabled}
          cellId={`total-${gi}`}
          label={`Сумма: ${p.name} (ВОР «${row.doc}»)`}
          title={mixed ? 'Сумму не ввести: у позиции разные единицы измерения'
            : !(view.volume > 0) ? 'Сумму можно ввести только у позиции с объёмом'
              : view.primary === 'unit' && view.priced ? 'Посчитано из цены: цена × объём' : undefined}
          invalid={draft?.status === 'error' && draft.mode === 'total'}
          onCommit={(raw) => onCommit(row, 'total', raw)}
        />
      </td>
      <td className="sp-state" data-label="">
        <RowState row={row} flash={flash} editable={editable} nameOf={nameOf} onRetry={onRetry} onDiscard={onDiscard}
          onConflict={onConflict} onAcceptVolume={onAcceptVolume} onHistory={onHistory} />
      </td>
    </tr>
  )
}

// Состояние строки — значки с подписью для диктора: сохраняется / сохранено / подставлено / не сохранено /
// изменено другим / объём изменился; история цены.
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
  } else if (flash?.kind === 'auto') {
    items.push(<span key="a" className="sp-st is-remote" role="status" title={`Подставлено из ВОР «${flash.from}»: такая же позиция`} aria-label={`Цена подставлена из ВОР «${flash.from}»`}>●</span>)
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
