import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRole } from '../../contexts/RoleContext'
import VirtualTableBody from '../VirtualTableBody'
import SupplyMoneyCell from './SupplyMoneyCell'
import SupplyConflictDialog from './SupplyConflictDialog'
import SupplyRateHistory from './SupplyRateHistory'
import SupplyLinkDialog from './SupplyLinkDialog'
import SupplySuggestMenu from './SupplySuggestMenu'
import { IconAlert, IconAlertCircle, IconCheck, IconClock, IconHistory, IconLink, IconPencil, IconRefresh, IconTrash } from '../icons/ActionIcons'
import { IconFileSpreadsheet, IconUpload } from '../icons/BsmIcons'
import { IconSearch } from '../icons/ToolbarIcons'
import { IconChevronDown } from '../icons/TenderHubIcons'
import { fetchEmployees, employeesById } from '../../services/employees'
import { requestDownloadUrl } from '../../services/s3'
import {
  autofillFromOtherTenders, classifyError, clearRate, deleteSource, downloadVorFile, estimateSignatures, loadChangeMarker,
  loadChangedRateIds, isWebLink, loadEstimateItems, loadLinks, loadLinksMarker, loadPricingBundle, loadPricingContext,
  loadPricingData, loadRateOrigins, loadRates, loadRatesByIds, loadSources, loadSuggestionCounts, loadVorFiles, removeLinks,
  renameEstimate, saveLinks, saveRate, saveSource, sourcesSignature, SUGGEST_BATCH,
} from '../../services/supplyPricing'
import { fmtPriceDate, isFreshPriceDate, rateUnitPrice } from '../../utils/supplyRateHelpers'
import { formatAmount, parseAmount, roundMoney } from '../../utils/money'
import { positionsFromEstimate } from '../../utils/vorMaterials'
import { VOR_PARSER_VERSION } from '../../utils/vorFiles'
import {
  estimateVersion, fileVersion, identicalTargets, planCleanup, planFileImports, planTabImports,
} from '../../utils/supplyAutoImport'
import './SupplyPricing.css'
// Рабочий стиль (docs/UI_GUIDELINES.md): корень панели — .ui-work, и в карточке тендера тоже.
import '../../styles/fonts.css'
import '../../styles/workUi.css'

// Библиотека Excel (430 КБ) и окно сопоставления колонок — только по требованию: разбор файла ВОР, выгрузка,
// «Указать лист и колонки». Таблица открывается без них.
const SupplyImportDialog = lazy(() => import('./SupplyImportDialog'))
const loadSheetReader = () => import('../../utils/vorMaterialsSheet')

// Расценка материалов ВОР снабжением (миграция 20261020) — одна таблица в двух местах: вкладка «Расценки
// снабжения» карточки тендера (тендерный отдел) и страница /tenders/materials/:id/pricing (снабжение, которому
// карточка с участниками и КП закрыта).
//
// Позиции загружаются сами, без кнопки: сначала лист «Материалы» файлов ВОР из «ВОРов и РД» основного
// тендера, если ни один не дал позиций — вкладка «ВОР» карточки (utils/supplyAutoImport). Записывать может
// только тот, у кого право правки, — у остальных подсказка, что ВОР загрузится при открытии снабжением.
// Не загрузилось — плашка с причиной и что сделать; причина запоминается (localStorage), и тот же файл не
// скачивается и не разбирается при каждом открытии. Все ВОР — в одной таблице, у каждого строка-шапка.
//
// Цены — tender_vor_supply_rates основного тендера: введённое сразу видно в карточке и в «Сравнении КП», в
// реестре «Расценки от снабжения СУ-10» — после его пересчёта (до 10 минут). Сохранение — само (через секунду
// после ввода, при уходе из поля), с версией строки: чужая правка не перетирается молча. Последняя известная
// версия каждой строки — в ratesRef, который обновляется сразу при записи (не на следующей отрисовке): очередь
// записей одной строки и опрос не работают со старой версией. Сохранённая цена — зелёная галочка в строке.
// Чужие правки — опросом журнала раз в 20 с: перечитываются только изменившиеся строки. Цена позиции
// подставляется в такие же позиции других ВОР, где цены нет (и туда, куда её подставили за этот сеанс, если
// там ничего не меняли).
//
// Колонка «Документ» — ссылка на чек, счёт или КП поставщика (tender_supply_links, миграция 20261022): к любой
// позиции, с ценой или без; одной позиции — «+ ссылка» в строке, нескольким сразу — отметить строки и «Ссылка на
// документ». Таблицы ссылок ещё нет в базе — колонки нет, остальное работает как раньше.
//
// Цены из других тендеров (миграция 20261023). Одинаковые позиции без цены (то же наименование по ключу и та же
// ед. изм.) получают самую свежую цену другого тендера не старше 3 месяцев сами — при открытии у того, у кого право
// правки, одним вызовом базы (supply_autofill); в строке — «цена из тендера № …» с днём расценки и документом.
// У позиции без своей цены, где есть похожие (наименование совпадает частично), — «похожие цены: N»: меню от самых
// недавних, «Взять» записывает цену с отметкой, откуда она, и прикладывает документ исходной позиции, если своего
// нет. Сколько похожих — спрашивается только для показанных строк, порциями. Функций ещё нет в базе — ничего этого
// нет, остальное работает как раньше.
//
// Больше VIRTUALIZE_FROM строк (у больших тендеров до 2,3 тыс. позиций) — в таблице только видимые строки
// (VirtualTableBody, прокрутка внутри, шапка и итог закреплены): иначе каждое сохранение заставляло браузер
// заново раскладывать и рисовать всю таблицу — секунды на слабом компьютере.

const POLL_MS = 20000
const RETRY_DELAYS = [5000, 15000, 30000, 60000]
const SAVED_FLASH_MS = 1600
const REMOTE_FLASH_MS = 6000
const FILL_NOTE_MS = 10000
const VOLUME_FMT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 })
const fmtVolume = (v) => (v == null || v === '' ? '—' : VOLUME_FMT.format(Number(v)))
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
const fmtClock = (iso) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '')
const posKey = (estimateName, k) => `${estimateName}∣${k}`
const draftsKey = (mainId) => `supply-pricing-drafts:${mainId}`
// Признак «ссылки менялись» — как loadLinksMarker: сколько их и время последней правки.
const linksMarker = (list) => `${list.length}|${list.reduce((m, l) => (String(l.updated_at || '') > m ? String(l.updated_at) : m), '')}`

const ACTIVE_STATUSES = new Set(['saving', 'queued', 'error', 'conflict'])
const VIRTUALIZE_FROM = 150
const SIMILAR_DELAY_MS = 250
const SIMILAR_PAUSE_MS = 30000
// Позиция, у которой спросить похожие цены: своей цены нет (пусто или скопирована), одна ед. изм.
const wantsSimilar = (row) => !!row.p.k && !row.p.units && !!String(row.p.unit || '').trim() && (!row.rate || !!row.rate.source_kind)
// У скопированной цены её источник — тоже среди похожих (свежий — в счёте базы): показываем остальные.
const similarOthers = (row, n) => (row.rate?.source_rate_id && isFreshPriceDate(row.rate.price_date) ? Math.max(0, n - 1) : n)

// Почему ВОР не загрузился и что сделать.
const PROBLEM_TEXT = {
  no_sheet: (p) => `в файле нет листа «Материалы»${p.sheetNames?.length ? ` (листы: ${p.sheetNames.join(', ')})` : ''}`
    + `${p.codeTried ? ' и нет листа ВОР с колонкой «КОД» и строками «мат.»' : ''}. `
    + 'Добавьте лист «Материалы» с колонками «Наименование», «Ед. изм.», «Объём» и загрузите файл в «ВОРы и РД» заново — или укажите лист вручную.',
  no_material_codes: (p) => `листа «Материалы» нет, а на листе «${p.sheetName}» есть колонка «КОД», но нет строк с кодом «мат.» (и строк без кода с расходом). Укажите лист и колонки вручную.`,
  no_header: (p) => `на листе «${p.sheetName}» не нашли шапку: в первых 30 строках нужны колонки «Наименование» и «Объём» (или «Кол-во»). Укажите колонки вручную.`,
  empty: (p) => `на листе «${p.sheetName}» нет позиций: все строки — разделы, итоги или пустые. Проверьте колонки.`,
  broken: (p) => `файл не читается как книга Excel${p.message ? ` (${p.message})` : ''}. Откройте его в Excel, сохраните как .xlsx и загрузите в «ВОРы и РД» заново.`,
  error: (p) => `файл не скачался (${p.message}). Повторите позже; если не поможет — загрузите файл в «ВОРы и РД» заново.`,
}
// Причины, которые зависят от самого файла: запоминаются до замены файла или «Повторить».
const FILE_PROBLEMS = new Set(['no_sheet', 'no_header', 'empty', 'broken', 'no_material_codes'])

const failureKey = (doc) => `supply-vor-failed:${doc.id}`
function readFailure(doc) {
  try {
    const v = JSON.parse(localStorage.getItem(failureKey(doc)) || 'null')
    return v && v.version === fileVersion(doc) && v.parser === VOR_PARSER_VERSION
      ? { doc, kind: v.kind, sheetNames: v.sheetNames, sheetName: v.sheetName, message: v.message, codeTried: v.codeTried }
      : null
  } catch { return null }
}
function storeFailure(p) {
  try {
    localStorage.setItem(failureKey(p.doc), JSON.stringify({
      version: fileVersion(p.doc), parser: VOR_PARSER_VERSION, kind: p.kind, sheetNames: p.sheetNames, sheetName: p.sheetName, message: p.message, codeTried: p.codeTried,
    }))
  } catch { /* приватный режим — только на этот сеанс */ }
}
function forgetFailure(doc) {
  try { localStorage.removeItem(failureKey(doc)) } catch { /* нечего забывать */ }
}
// Отказ, который уже записала служба osp-api (tender_supply_import_state, миграция 20261024): тот же файл той же
// версии этим же разбором — страница его не скачивает. Только причины из самого файла: большой или тяжёлый для
// сервера файл страница разбирает сама.
function serverFailure(state, doc) {
  const i = (state?.issues || []).find((x) => x.doc_id === doc.id && x.version === fileVersion(doc)
    && x.parser === VOR_PARSER_VERSION && FILE_PROBLEMS.has(x.kind))
  return i ? { doc, kind: i.kind, sheetNames: i.sheetNames || undefined, sheetName: i.sheetName || undefined, message: i.message || undefined, codeTried: !!i.codeTried } : null
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
    total = volume != null ? roundMoney(unitPrice * volume) : null
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

// В базе уже то, что хотели записать (например, первая попытка прошла, а ответ потерялся) — это не конфликт.
function reached(current, intent) {
  if (intent.mode === 'clear') return !current
  return !!current && current.price_input === intent.mode && Number(current.input_value) === Number(intent.value)
}

const loadStoredDrafts = (mainId) => {
  try { return JSON.parse(localStorage.getItem(draftsKey(mainId)) || '{}') || {} } catch { return {} }
}
const storeDrafts = (mainId, drafts) => {
  try {
    const keep = {}
    for (const [k, d] of Object.entries(drafts)) {
      if (ACTIVE_STATUSES.has(d.status) && !d.auto) keep[k] = { mode: d.mode, value: d.value, estimateName: d.estimateName, at: d.at, source: d.source || undefined }
    }
    if (Object.keys(keep).length) localStorage.setItem(draftsKey(mainId), JSON.stringify(keep))
    else localStorage.removeItem(draftsKey(mainId))
  } catch { /* приватный режим — черновик только в памяти */ }
}

// Состояние, у которого последнее значение нужно сразу (до отрисовки): ref обновляется в момент записи.
function useSyncedState(initial) {
  const [value, setValue] = useState(initial)
  const ref = useRef(initial)
  const set = useCallback((next) => {
    const v = typeof next === 'function' ? next(ref.current) : next
    ref.current = v
    setValue(v)
  }, [])
  return [value, set, ref]
}

// ctx — готовый контекст или tenderId — загрузим сами (вместе с данными, за два шага к серверу). onContext —
// странице для шапки. estimateItems — строки вкладки «ВОР», если они уже есть у карточки. onRatesChange —
// карточке, чтобы «Сравнение КП» и выгрузка видели новые цены. excelImport — { onImport(estimateName) }:
// загрузка цен из Excel (есть только в карточке). refreshToken — карточка увеличивает его после своей записи
// (Excel, удаление). active — вкладка карточки открыта (скрытая не опрашивает сервер).
export default function SupplyPricingPanel({
  ctx: ctxProp = null, tenderId = null, estimateItems: itemsProp = null, onRatesChange, onContext, excelImport = null,
  refreshToken = 0, variant = 'page', active = true,
}) {
  const { canEdit, user, isAdmin, isSuperAdmin } = useRole()
  const canEditRole = canEdit('tenders') || canEdit('tenders_materials')
  // Администратору в колонке «Дата цены» — ещё и кто поставил цену.
  const showAuthor = !!(isAdmin || isSuperAdmin)
  const myId = user?.id || null

  const [ctx, setCtx] = useState(ctxProp)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [missing, setMissing] = useState(false)
  const [files, setFiles] = useState([])
  const [sources, setSourcesState] = useState([])
  const [rates, setRates, ratesRef] = useSyncedState([])
  const [drafts, setDrafts, draftsRef] = useSyncedState({})
  const [loadedItems, setLoadedItems] = useState(null)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [flash, setFlash] = useState({}) // key → { kind: 'saved' | 'remote' | 'auto', by, at, from }
  const [conflict, setConflict] = useState(null)
  const [historyFor, setHistoryFor] = useState(null)
  const [mappingFile, setMappingFile] = useState(null)
  const [problems, setProblems] = useState([])
  const [importing, setImporting] = useState(null) // { label, done, total }
  const [employees, setEmployees] = useState(() => new Map())
  const [notice, setNotice] = useState('')
  const [fillNote, setFillNote] = useState('')
  const [lastSavedAt, setLastSavedAt] = useState(null)
  const [bindTarget, setBindTarget] = useState({})
  const [links, setLinks] = useState(null) // null — таблицы ссылок ещё нет в базе (миграция 20261022)
  const [selected, setSelected] = useState(() => new Set()) // отмеченные позиции (ключи «ВОР∣ключ»)
  const [linkDialog, setLinkDialog] = useState(null) // { targets }
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkError, setLinkError] = useState('')
  const linksMarkerRef = useRef(null)
  // Цены из других тендеров: reuseOff — функций в базе ещё нет; origins — откуда скопированы цены (id цены →
  // тендер, объект, документ); similar — сколько похожих у позиции («ВОР∣ключ» → n); suggest — открытое меню.
  const [reuseOff, setReuseOff] = useState(false)
  const reuseOffRef = useRef(false)
  const [origins, setOrigins] = useState(() => new Map())
  const [similar, setSimilar] = useState(() => new Map())
  const [suggest, setSuggest] = useState(null) // { row, anchor }
  const [reuseNote, setReuseNote] = useState('')
  // Состояние разбора позиций службой osp-api: null — службы/таблицы нет (миграция 20261024).
  const [importState, setImportState, importStateRef] = useSyncedState(null)
  const ignoreServerFailure = useRef(new Set()) // «Повторить» — файл разбирается заново, даже если служба не смогла
  // Фильтр по дню расценки (с … по …), строки вида «ГГГГ-ММ-ДД».
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const mainId = ctx?.mainId || null
  const editable = canEditRole && !!ctx && !ctx.locked && !missing
  const docViewsRef = useRef([])
  const inflight = useRef(new Set())
  const queued = useRef(new Map())
  const retryTimers = useRef(new Map())
  const recentlyDeleted = useRef(new Map())
  const recentLocal = useRef(new Map())
  const autoFilled = useRef(new Map()) // key → { id, version } — цену подставили мы, и её с тех пор не меняли
  const logIdRef = useRef(null)
  const sourcesSigRef = useRef(null)
  const runSaveRef = useRef(null)
  const failedFiles = useRef(new Map())
  const autoBusy = useRef(false)
  const autoKey = useRef('')
  const autoRerun = useRef(false)
  const fillTimer = useRef(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const [autoTick, setAutoTick] = useState(0)

  const setSources = useCallback((list) => {
    sourcesSigRef.current = sourcesSignature(list)
    setSourcesState(list)
  }, [])

  // Карточке — свежие цены для «Сравнения КП» и выгрузки.
  const onRatesChangeRef = useRef(onRatesChange)
  onRatesChangeRef.current = onRatesChange
  useEffect(() => { if (!loading && !missing) onRatesChangeRef.current?.(rates) }, [rates, loading, missing])
  const onContextRef = useRef(onContext)
  onContextRef.current = onContext
  const updateCtx = useCallback((c) => {
    setCtx(c)
    onContextRef.current?.(c)
  }, [])

  // ── Загрузка ──────────────────────────────────────────────────────────────────────────────────────
  const applyData = useCallback((d) => {
    logIdRef.current = d.logId
    setFiles(d.files)
    setSources(d.sources)
    setRates(d.rates)
    setLinks(d.links ?? null)
    linksMarkerRef.current = d.links ? linksMarker(d.links) : null
    setImportState(d.importState ?? null)
    if (d.items) setLoadedItems(d.items)
  }, [setRates, setSources, setImportState])

  const reloadData = useCallback(async (id) => applyData(await loadPricingData(id)), [applyData])

  const wantItems = useRef(itemsProp == null)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadError('')
    setMissing(false)
    ;(async () => {
      try {
        // Строки вкладки «ВОР» (у больших ВОР — десятки тысяч) таблица не ждёт: они грузятся следом, фоном.
        const b = await loadPricingBundle(tenderId, { ctx: ctxProp })
        if (!alive) return
        updateCtx(b.ctx)
        if (!b.ctx) return
        if (b.error) {
          if ((b.error.kind || classifyError(b.error)?.kind) === 'missing') setMissing(true)
          else setLoadError(b.error.message || 'Не удалось загрузить расценку')
          return
        }
        applyData(b)
        if (wantItems.current) {
          loadEstimateItems(b.ctx.mainId)
            .then((items) => { if (alive) setLoadedItems(items) })
            .catch(() => { if (alive) setLoadedItems([]) })
        }
        const stored = loadStoredDrafts(b.ctx.mainId)
        if (Object.keys(stored).length) {
          setDrafts(Object.fromEntries(Object.entries(stored).map(([k, d]) => [k, {
            ...d, status: 'error', kind: 'stored', message: 'Не сохранено при прошлом открытии — повторите или отмените ввод',
          }])))
        }
      } catch (e) {
        if (alive) setLoadError(e.message || 'Не удалось загрузить тендер')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [ctxProp, tenderId, applyData, updateCtx, setDrafts])

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
    reloadData(mainId).catch((e) => setNotice(e.message))
  }, [refreshToken, mainId, reloadData])

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
  }, [draftsRef])
  useEffect(() => () => {
    for (const t of retryTimers.current.values()) clearTimeout(t)
    clearTimeout(fillTimer.current)
  }, [])

  // ── Автозагрузка позиций ВОР ──────────────────────────────────────────────────────────────────────
  const runAutoImport = useCallback(async () => {
    if (autoBusy.current || !mainId || !estimate) return
    autoBusy.current = true
    const found = []
    let changed = false
    const remember = (p) => {
      failedFiles.current.set(p.doc.id, p)
      if (FILE_PROBLEMS.has(p.kind)) storeFailure(p)
      found.push(p)
    }
    try {
      const cardNames = estimate.names
      const { jobs, skipped } = planFileImports(files, sources, cardNames)
      const fresh = []
      for (const j of jobs) {
        const known = failedFiles.current.get(j.doc.id) || readFailure(j.doc)
          || (!ignoreServerFailure.current.has(j.doc.id) && serverFailure(importStateRef.current, j.doc))
        if (known) found.push(known)
        else fresh.push(j)
      }
      let fileSourceCreated = sources.some((s) => s.source === 'vor_file')
      const sheet = fresh.length ? await loadSheetReader() : null
      for (const [i, job] of fresh.entries()) {
        setImporting({ label: `файл «${job.doc.file_name}»`, done: i, total: fresh.length })
        let bytes
        try {
          bytes = await downloadVorFile(job.doc)
        } catch (e) {
          const p = { doc: job.doc, kind: 'error', message: e.message }
          if ((e.kind || classifyError(e)?.kind) === 'retry') found.push(p)
          else remember(p)
          continue
        }
        // Лист «Материалы», иначе сам лист ВОР по колонке «КОД» — тот же разбор, что у службы osp-api (один раз на
        // версию файла: дальше позиции лежат в базе, а причина отказа — в базе и в браузере).
        const parsed = sheet.parseVorFileBytes(bytes, job.existing?.column_map)
        if (parsed.error) {
          remember({ doc: job.doc, kind: parsed.error, message: parsed.message, sheetNames: parsed.sheetNames, sheetName: parsed.sheetName, codeTried: parsed.codeTried })
          continue
        }
        try {
          await saveSource({
            existing: job.existing, mainId, estimateName: job.name, source: 'vor_file', doc: job.doc,
            sheetName: parsed.sheetName, columnMap: parsed.map, sourceVersion: fileVersion(job.doc), positions: parsed.positions,
          })
          changed = true
          fileSourceCreated = true
        } catch (e) {
          // Одновременно загрузил другой — его список уже в базе.
          if (e.kind === 'conflict') { changed = true; continue }
          found.push({ doc: job.doc, kind: 'error', message: e.message })
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
  }, [mainId, estimate, files, sources, ratesRef, setSources, importStateRef])

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
    ignoreServerFailure.current.add(doc.id)
    forgetFailure(doc)
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

  // Ссылки на документы по позициям; null — колонки «Документ» нет (таблицы ссылок ещё нет в базе).
  const linksByKey = useMemo(() => {
    if (!links) return null
    const m = new Map()
    for (const l of links) m.set(posKey(l.estimate_name, l.material_key), l)
    return m
  }, [links])
  const linksOn = linksByKey !== null
  const selectable = linksOn && editable

  // Позиции — только от списков (не пересобираются при каждой цене: строки таблицы не перерисовываются зря).
  const sourceViews = useMemo(() => sources.map((s) => ({ source: s, name: s.estimate_name, positions: mergePositions(s.positions) })), [sources])

  const docViews = useMemo(() => sourceViews.map((d) => {
    let priced = 0
    let total = 0
    for (const p of d.positions) {
      const rate = ratesByKey.get(posKey(d.name, p.k))?.[0]
      if (!rate) continue
      priced += 1
      total += rateTotal(rate, p) || 0
    }
    return { ...d, priced, total: roundMoney(total) }
  }), [sourceViews, ratesByKey])
  docViewsRef.current = docViews

  const grand = useMemo(() => docViews.reduce((a, d) => ({
    positions: a.positions + d.positions.length, priced: a.priced + d.priced, total: roundMoney(a.total + d.total),
  }), { positions: 0, priced: 0, total: 0 }), [docViews])

  // Цены без позиции: наименования нет ни в одном списке позиций этого ВОР (ВОР обновился, Excel с другим
  // написанием, ВОР без списка позиций).
  const orphans = useMemo(() => {
    const keys = new Set(sourceViews.flatMap((d) => d.positions.map((p) => posKey(d.name, p.k))))
    return rates.filter((r) => !keys.has(posKey(r.estimate_name, r.material_key)))
  }, [sourceViews, rates])

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
      } else if (estimate && estimateItems?.length) {
        const sig = estimate.signatures.get(s.estimate_name)
        if (!sig) notes.push({ kind: 'stale', text: 'ВОР удалён из вкладки «ВОР» карточки — позиции остались от него.' })
        else if (s.source_version && estimateVersion(sig) !== s.source_version && !editable) notes.push({ kind: 'stale', text: 'ВОР в карточке перезагружен — позиции обновятся при открытии снабжением или тендерным отделом.' })
      }
      if (notes.length) out.set(s.estimate_name, notes)
    }
    return out
  }, [sources, files, estimate, estimateItems, editable])

  // Без права правки автозагрузки нет: какие файлы ещё не загружены, и почему не загрузились (если служба osp-api
  // уже пробовала) — те же плашки, без кнопок.
  const viewerJobs = useMemo(() => {
    if (editable || !estimate) return []
    return planFileImports(files, sources, estimate.names).jobs
  }, [editable, estimate, files, sources])
  const viewerProblems = useMemo(() => viewerJobs.map((j) => serverFailure(importState, j.doc)).filter(Boolean), [viewerJobs, importState])
  const pendingForViewer = useMemo(() => viewerJobs.filter((j) => !viewerProblems.some((p) => p.doc.id === j.doc.id)), [viewerJobs, viewerProblems])

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
        if (dateFrom || dateTo) {
          const d = r.rate?.price_date
          if (!d || (dateFrom && d < dateFrom) || (dateTo && d > dateTo)) return false
        }
        if (filter === 'unpriced') return !r.view.priced
        if (filter === 'priced') return r.view.priced
        return true
      })
      const open = !collapsed.has(d.name)
      for (const r of rows) r.gi = open ? gi++ : -1
      return { doc: d, rows, open }
    })
  }, [docViews, ratesByKey, drafts, search, filter, collapsed, dateFrom, dateTo])

  // Строки таблицы подряд — шапки ВОР и позиции: так их рисует и обычная таблица, и окно видимых строк.
  const items = useMemo(() => {
    const out = []
    for (const s of sections) {
      if (!s.rows.length && (search || filter !== 'all' || dateFrom || dateTo)) continue
      out.push({ kind: 'head', s, first: out.length === 0 })
      if (!s.open) continue
      if (!s.rows.length) out.push({ kind: 'empty', s })
      for (const row of s.rows) out.push({ kind: 'row', row })
    }
    return out
  }, [sections, search, filter, dateFrom, dateTo])
  const virtual = items.length > VIRTUALIZE_FROM
  const tableWrapRef = useRef(null)

  // ── Сохранение ────────────────────────────────────────────────────────────────────────────────────
  const setDraft = useCallback((key, value) => {
    setDrafts((prev) => {
      const next = { ...prev }
      if (value) next[key] = { ...value, at: value.at || new Date().toISOString() }
      else delete next[key]
      return next
    })
  }, [setDrafts])

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
  }, [setRates])

  const isOwnAuto = useCallback((key, rate) => {
    const a = autoFilled.current.get(key)
    return !!a && !!rate && a.id === rate.id && a.version === rate.row_version
  }, [])
  // Цену можно заменить подстановкой из такой же позиции этого тендера: её подставили мы за этот сеанс или база
  // из другого тендера (своя цена этого тендера важнее чужой).
  const replaceable = useCallback((key, rate) => isOwnAuto(key, rate) || rate?.source_kind === 'auto', [isOwnAuto])

  const reloadContext = useCallback(async () => {
    try {
      const c = await loadPricingContext(ctx?.opened?.id || tenderId)
      if (c) updateCtx(c)
    } catch { /* останется прежнее */ }
  }, [ctx, tenderId, updateCtx])

  // Цену позиции — в такие же позиции других ВОР, где цены ещё нет (решение пользователя 16.10), и туда, куда
  // её подставили за этот сеанс или база из другого тендера, если там с тех пор ничего не меняли (исправили цену —
  // исправится и там). Выбранная из другого тендера цена переходит с той же отметкой и днём расценки.
  const fillIdentical = useCallback((estimateName, position, row) => {
    const price = roundMoney(rateUnitPrice(row))
    if (!(price > 0)) return
    const source = row.source_rate_id ? { rateId: row.source_rate_id, kind: row.source_kind } : null
    const taken = (name, k) => {
      const key = posKey(name, k)
      const d = draftsRef.current[key]
      if (d && !d.auto) return true
      const r = rateIn(ratesRef.current, key)
      if (!r) return false
      return !replaceable(key, r) || (r.price_input === 'unit' && Number(r.supply_price) === price && (r.source_rate_id || null) === (source?.rateId || null))
    }
    const targets = identicalTargets(docViewsRef.current, estimateName, position, taken)
    for (const t of targets) {
      runSaveRef.current(posKey(t.name, t.position.k), { mode: 'unit', value: price, estimateName: t.name, position: t.position, auto: true, from: estimateName, source })
    }
    if (targets.length) {
      const docs = [...new Set(targets.map((t) => `«${t.name}»`))].join(', ')
      setFillNote(`Цена «${position.name}» подставлена в такие же позиции: ВОР ${docs}.`)
      clearTimeout(fillTimer.current)
      fillTimer.current = setTimeout(() => setFillNote(''), FILL_NOTE_MS)
    }
  }, [draftsRef, ratesRef, replaceable])

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
    // Последняя версия строки — из ratesRef: он обновлён ответом предыдущей записи ещё до отрисовки.
    const rate = rateIn(ratesRef.current, key)
    try {
      // Подстановка в одинаковую позицию: цену там поставил человек — его не трогаем.
      if (intent.auto && rate && !replaceable(key, rate)) {
        if (!queued.current.has(key)) setDraft(key, null)
        return
      }
      const res = intent.mode === 'clear'
        ? (rate ? await clearRate(rate) : { status: 'ok', row: null })
        : await saveRate({ rate, mainId, estimateName: intent.estimateName, position: intent.position, mode: intent.mode, value: intent.value, source: intent.source })
      const ok = res.status === 'ok' || reached(res.current, intent)
      const row = res.status === 'ok' ? res.row : res.current
      if (ok) {
        if (row) applyRow(null, row)
        else if (rate) applyRow(rate, null)
        if (intent.auto && row) autoFilled.current.set(key, { id: row.id, version: row.row_version })
        else autoFilled.current.delete(key)
        if (!queued.current.has(key)) setDraft(key, null)
        flashRow(key, intent.auto ? { kind: 'auto', from: intent.from } : { kind: 'saved' }, intent.auto ? REMOTE_FLASH_MS : SAVED_FLASH_MS)
        if (!intent.auto) {
          setLastSavedAt(new Date().toISOString())
          if (row) fillIdentical(intent.estimateName, intent.position, row)
        }
      } else if (intent.auto) {
        if (res.current) applyRow(null, res.current)
        if (!queued.current.has(key)) setDraft(key, null)
      } else {
        // Строку изменил другой: очередь этой строки не пишем поверх него — спрашиваем (последнее введённое).
        const mine = queued.current.get(key) || intent
        queued.current.delete(key)
        if (res.current) applyRow(null, res.current)
        else if (rate) applyRow(rate, null)
        setDraft(key, { ...mine, status: 'conflict' })
        setConflict({ key, intent: mine, current: res.current, position: mine.position })
      }
    } catch (e) {
      const kind = e.kind || classifyError(e)?.kind || 'error'
      if (intent.auto && kind !== 'retry') {
        if (!queued.current.has(key)) setDraft(key, null)
      } else {
        const attempts = (draftsRef.current[key]?.attempts || 0) + 1
        setDraft(key, { ...intent, status: 'error', kind, message: e.message, attempts })
        if (kind === 'retry') {
          const delay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]
          retryTimers.current.set(key, setTimeout(() => {
            retryTimers.current.delete(key)
            const d = draftsRef.current[key]
            if (d?.status === 'error' && d.kind === 'retry') {
              runSaveRef.current(key, { mode: d.mode, value: d.value, estimateName: d.estimateName, position: d.position, auto: d.auto, from: d.from, source: d.source })
            }
          }, delay))
        }
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
  }, [mainId, ratesRef, draftsRef, applyRow, setDraft, flashRow, reloadContext, fillIdentical, replaceable])
  runSaveRef.current = runSave

  // Ячейка отдала набранное (через секунду после ввода, при уходе из поля). Строка и черновик — последние
  // известные, а не с прошлой отрисовки.
  const commit = useCallback((row, field, raw) => {
    const { p, key, doc } = row
    const rate = rateIn(ratesRef.current, key)
    const draft = draftsRef.current[key] || null
    const view = rowView(p, rate, draft)
    const value = parseAmount(raw)
    const base = { estimateName: doc, position: p }
    if (value == null) {
      if (!rate && !inflight.current.has(key) && !queued.current.has(key)) {
        if (draft) setDraft(key, null)
        return
      }
      runSave(key, { ...base, mode: 'clear', value: null })
      return
    }
    if (value <= 0) {
      setDraft(key, { ...base, mode: field, value, status: 'error', kind: 'invalid', message: 'Цена и сумма должны быть больше нуля' })
      return
    }
    if (field === 'total' && !(view.volume > 0)) {
      setDraft(key, { ...base, mode: field, value, status: 'error', kind: 'invalid', message: 'Сумму можно ввести только у позиции с объёмом' })
      return
    }
    // То же, что уже сохранено или сохраняется, — не писать ещё раз.
    const pending = !!draft && (draft.status === 'saving' || draft.status === 'queued')
    const shown = field === 'unit' ? view.unitPrice : view.total
    if (shown != null && roundMoney(value) === roundMoney(shown) && (!draft || pending) && !view.volumeChanged) return
    runSave(key, { ...base, mode: field, value })
  }, [ratesRef, draftsRef, runSave, setDraft])

  const retryDraft = (key) => {
    const d = draftsRef.current[key]
    if (!d) return
    const estimateName = d.estimateName || key.split('∣')[0]
    const owner = docViews.find((x) => x.name === estimateName)
    const position = d.position || owner?.positions.find((p) => posKey(estimateName, p.k) === key)
    if (!position) return
    runSave(key, { mode: d.mode, value: d.value, estimateName, position, source: d.source })
  }
  const discardDraft = (key) => {
    const timer = retryTimers.current.get(key)
    if (timer) { clearTimeout(timer); retryTimers.current.delete(key) }
    queued.current.delete(key)
    setDraft(key, null)
  }

  const acceptVolume = (row) => {
    const { p, key, doc } = row
    const rate = rateIn(ratesRef.current, key)
    if (!rate) return
    const volume = p.units || p.volume == null ? null : Number(p.volume)
    if (rate.price_input === 'total' && volume > 0) {
      runSave(key, { estimateName: doc, position: p, mode: 'total', value: roundMoney(rateUnitPrice(rate) * volume) })
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
    const own = ratesRef.current.filter((r) => r.estimate_name === d.name)
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
      await reloadData(mainId)
    } catch (e) {
      setNotice(`Не удалось привязать: ${e.message}`)
    }
  }

  // ── Синхронизация ─────────────────────────────────────────────────────────────────────────────────
  // Строки с сервера поверх своих: своя новее (ответ записи уже пришёл) — остаётся своя; только что удалённые
  // нами не возвращаются. ids — какие строки перечитаны: тех, что не пришли, на сервере больше нет.
  const mergeServerRows = useCallback((rows, ids = null) => {
    const now = Date.now()
    for (const [id, at] of recentlyDeleted.current) if (now - at > 60000) recentlyDeleted.current.delete(id)
    for (const [id, at] of recentLocal.current) if (now - at > 60000) recentLocal.current.delete(id)
    const remote = []
    setRates((prev) => {
      const byId = new Map(rows.map((r) => [r.id, r]))
      const map = new Map(prev.map((r) => [r.id, r]))
      if (ids) {
        for (const id of ids) if (!byId.has(id)) map.delete(id)
      } else {
        for (const l of prev) if (!byId.has(l.id) && !recentLocal.current.has(l.id)) map.delete(l.id)
      }
      for (const r of rows) {
        if (recentlyDeleted.current.has(r.id)) continue
        const l = map.get(r.id)
        if (l && l.row_version >= r.row_version) continue
        if (r.updated_by && r.updated_by !== myId) remote.push(r)
        map.set(r.id, r)
      }
      return [...map.values()]
    })
    for (const r of remote) flashRow(posKey(r.estimate_name, r.material_key), { kind: 'remote', by: r.updated_by, at: r.updated_at }, REMOTE_FLASH_MS)
  }, [myId, setRates, flashRow])

  // Новые записи журнала → перечитать только эти строки; записей очень много — все цены.
  const syncRates = useCallback(async (upTo) => {
    const from = logIdRef.current ?? 0
    const changed = await loadChangedRateIds(mainId, from)
    if (!changed) {
      mergeServerRows(await loadRates(mainId))
      logIdRef.current = upTo
      return
    }
    if (changed.ids.length) mergeServerRows(await loadRatesByIds(mainId, changed.ids), changed.ids)
    logIdRef.current = changed.lastId
  }, [mainId, mergeServerRows])

  const tickRef = useRef(null)
  useEffect(() => {
    if (!mainId || missing) return undefined
    let busy = false
    const tick = async () => {
      if (busy || document.visibilityState !== 'visible' || !activeRef.current || logIdRef.current == null) return
      busy = true
      try {
        const m = await loadChangeMarker(mainId)
        if (m.logId > logIdRef.current) await syncRates(m.logId)
        if (m.sources !== sourcesSigRef.current) setSources(await loadSources(mainId))
        if (linksMarkerRef.current != null && await loadLinksMarker(mainId) !== linksMarkerRef.current) {
          const fresh = await loadLinks(mainId)
          if (fresh) {
            linksMarkerRef.current = linksMarker(fresh)
            setLinks(fresh)
          }
        }
      } catch { /* сеть — следующий раз */ } finally {
        busy = false
      }
    }
    tickRef.current = tick
    const id = setInterval(tick, POLL_MS)
    // Вернулись на вкладку — заодно проверить, не добавили ли файлы ВОР.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !activeRef.current) return
      tick()
      loadVorFiles(mainId).then(setFiles).catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      clearInterval(id)
      tickRef.current = null
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [mainId, missing, syncRates, setSources])
  // Снова открыли вкладку карточки — сразу проверить, что изменилось, пока её не было видно.
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current) {
      tickRef.current?.()
      if (mainId) loadVorFiles(mainId).then(setFiles).catch(() => {})
    }
    wasActive.current = active
  }, [active, mainId])

  // ── Цены из других тендеров ───────────────────────────────────────────────────────────────────────
  const turnReuseOff = useCallback(() => {
    reuseOffRef.current = true
    setReuseOff(true)
  }, [])

  // Одинаковые позиции — сами: при открытии и когда изменились списки позиций (новый ВОР, заменённый файл). Пишет
  // база; новые цены — через журнал, как чужие правки (только эти строки).
  const autofillKey = useRef('')
  const autofillBusy = useRef(false)
  const autofillTotal = useRef(0)
  const [autofillTick, setAutofillTick] = useState(0)
  useEffect(() => {
    if (loading || missing || !editable || !mainId || reuseOffRef.current || !sources.length) return
    const key = sourcesSignature(sources)
    if (autofillKey.current === key) return
    if (autofillBusy.current) return
    autofillKey.current = key
    autofillBusy.current = true
    ;(async () => {
      try {
        const n = await autofillFromOtherTenders(mainId)
        if (n == null) { turnReuseOff(); return }
        if (n > 0) {
          autofillTotal.current += n
          setReuseNote(`Из других тендеров подставлено цен: ${autofillTotal.current} — то же наименование и ед. изм., не старше 3 месяцев.`)
          const m = await loadChangeMarker(mainId)
          if (m.logId > (logIdRef.current ?? 0)) await syncRates(m.logId)
        }
      } catch {
        autofillKey.current = '' // сеть — при следующем изменении списков или открытии
      } finally {
        autofillBusy.current = false
        // Пока шёл вызов, списки изменились — ещё раз.
        setAutofillTick((t) => t + 1)
      }
    })()
  }, [loading, missing, editable, mainId, sources, syncRates, turnReuseOff, autofillTick])

  // Откуда скопированы цены — для пометки в строке; спрашиваем только про новые копии.
  const originsAsked = useRef(new Set())
  useEffect(() => {
    if (!mainId || missing || reuseOff) return
    const fresh = rates.filter((r) => r.source_kind && !origins.has(r.id) && !originsAsked.current.has(r.id))
    if (!fresh.length) return
    for (const r of fresh) originsAsked.current.add(r.id)
    let alive = true
    loadRateOrigins(mainId)
      .then((rows) => {
        if (!alive) return
        if (rows == null) { turnReuseOff(); return }
        setOrigins(new Map(rows.map((o) => [o.rate_id, o])))
      })
      .catch(() => { for (const r of fresh) originsAsked.current.delete(r.id) })
    return () => { alive = false }
  }, [rates, origins, mainId, missing, reuseOff, turnReuseOff])

  // Сколько похожих цен — только у показанных строк: строка при отрисовке встаёт в очередь, очередь уходит в базу
  // порцией (до SUGGEST_BATCH) через SIMILAR_DELAY_MS. Прокрутили — следующие строки так же.
  const similarWant = useRef(new Map())
  const similarAsked = useRef(new Set())
  const similarTimer = useRef(null)
  const similarPausedUntil = useRef(0)
  const flushSimilarRef = useRef(null)
  flushSimilarRef.current = async () => {
    similarTimer.current = null
    if (!mainId || reuseOffRef.current || !similarWant.current.size) return
    if (Date.now() < similarPausedUntil.current) {
      similarTimer.current = setTimeout(() => flushSimilarRef.current?.(), similarPausedUntil.current - Date.now())
      return
    }
    const batch = [...similarWant.current.values()].slice(0, SUGGEST_BATCH)
    for (const it of batch) { similarWant.current.delete(it.key); similarAsked.current.add(it.key) }
    try {
      const rows = await loadSuggestionCounts(mainId, batch.map(({ doc, k, name, unit }) => ({ doc, k, name, unit })))
      if (rows == null) { turnReuseOff(); return }
      setSimilar((prev) => {
        const next = new Map(prev)
        for (const it of batch) next.set(it.key, 0)
        for (const r of rows) next.set(posKey(r.estimate_name, r.k), r.n)
        return next
      })
    } catch {
      // Сеть или перегрузка — те же строки ещё раз, но не сразу.
      for (const it of batch) { similarAsked.current.delete(it.key); similarWant.current.set(it.key, it) }
      similarPausedUntil.current = Date.now() + SIMILAR_PAUSE_MS
    }
    if (similarWant.current.size && !similarTimer.current) similarTimer.current = setTimeout(() => flushSimilarRef.current?.(), SIMILAR_DELAY_MS)
  }
  const noteSimilar = (row) => {
    if (reuseOffRef.current || !activeRef.current || !wantsSimilar(row)) return
    if (similarAsked.current.has(row.key) || similarWant.current.has(row.key)) return
    similarWant.current.set(row.key, { key: row.key, doc: row.doc, k: row.p.k, name: row.p.name, unit: row.p.unit })
    if (!similarTimer.current) similarTimer.current = setTimeout(() => flushSimilarRef.current?.(), SIMILAR_DELAY_MS)
  }
  useEffect(() => () => clearTimeout(similarTimer.current), [])

  // «Взять» из меню похожих: цена за единицу с отметкой источника; документ исходной позиции — если своего нет.
  const pickSuggestion = (row, s) => {
    setSuggest(null)
    runSave(row.key, { mode: 'unit', value: Number(s.unit_price), estimateName: row.doc, position: row.p, source: { rateId: s.rate_id, kind: 'pick' } })
    if (linksByKey && s.url && !linksByKey.get(row.key)) {
      saveLinks(mainId, [{ estimateName: row.doc, name: row.p.name }], s.url)
        .then((saved) => setLinks((prev) => {
          const byId = new Map((prev || []).map((l) => [l.id, l]))
          for (const r of saved) byId.set(r.id, r)
          return [...byId.values()]
        }))
        .catch((e) => setNotice(`Цена взята, а документ к позиции не прикрепился: ${e.message}`))
    }
  }
  const closeSuggest = useCallback((restoreFocus) => {
    setSuggest((cur) => {
      if (restoreFocus && cur?.anchor?.isConnected) setTimeout(() => cur.anchor.focus(), 0)
      return null
    })
  }, [])

  // ── Выгрузка в Excel: по листу на ВОР, как лист «Материалы» ВОР ─────────────────────────────────────
  const exportExcel = async () => {
    let XLSX
    try {
      XLSX = await import('xlsx')
    } catch (e) {
      setNotice(`Выгрузка не открылась: ${e.message}`)
      return
    }
    const wb = XLSX.utils.book_new()
    const used = new Set()
    for (const d of docViews) {
      const aoa = [['№', 'Наименование', 'Ед. изм.', 'Объём', 'Цена за ед. с доставкой и НДС, ₽', 'Итого с НДС, ₽',
        ...(datesOn ? ['Дата цены'] : []), ...(datesOn && showAuthor ? ['Цену поставил'] : []), ...(linksOn ? ['Документ'] : [])]]
      d.positions.forEach((p, i) => {
        const rate = ratesByKey.get(posKey(d.name, p.k))?.[0] || null
        const v = rowView(p, rate, null)
        aoa.push([i + 1, p.name, p.units ? p.units.map((u) => u.unit).filter(Boolean).join(', ') : (p.unit || ''),
          p.units ? p.units.map((u) => `${fmtVolume(u.volume)} ${u.unit || ''}`).join('; ') : (p.volume ?? ''),
          v.unitPrice != null ? roundMoney(v.unitPrice) : '', v.total ?? '',
          ...(datesOn ? [fmtPriceDate(rate?.price_date)] : []),
          ...(datesOn && showAuthor ? [rate ? authorText(rate, origins.get(rate.id), nameOf) : ''] : []),
          ...(linksOn ? [linksByKey.get(posKey(d.name, p.k))?.url || ''] : [])])
      })
      aoa.push(['', 'Итого', '', '', '', d.total])
      const ws = XLSX.utils.aoa_to_sheet(aoa)
      ws['!cols'] = [{ wch: 6 }, { wch: 60 }, { wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 18 },
        ...(datesOn ? [{ wch: 12 }] : []), ...(datesOn && showAuthor ? [{ wch: 28 }] : []), { wch: 40 }]
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

  // ── Отметка позиций и ссылки на документы ─────────────────────────────────────────────────────────
  const toggleSelect = (key) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const setSelectedKeys = (keys, on) => setSelected((prev) => {
    const next = new Set(prev)
    for (const k of keys) { if (on) next.add(k); else next.delete(k) }
    return next
  })

  // Окно ссылки для позиций по ключам: одна (кнопка в строке) или все отмеченные.
  const openLinkDialog = (keys) => {
    const targets = []
    for (const d of docViewsRef.current) {
      for (const p of d.positions) {
        const key = posKey(d.name, p.k)
        if (keys.has(key)) targets.push({ key, name: p.name, estimateName: d.name, link: linksByKey?.get(key) || null })
      }
    }
    if (!targets.length) return
    setLinkError('')
    setLinkDialog({ targets })
  }
  const linkDone = (text) => {
    setFillNote(text)
    clearTimeout(fillTimer.current)
    fillTimer.current = setTimeout(() => setFillNote(''), FILL_NOTE_MS)
  }
  const saveLink = async (url) => {
    const { targets } = linkDialog
    setLinkBusy(true)
    setLinkError('')
    try {
      const rows = await saveLinks(mainId, targets.map((t) => ({ estimateName: t.estimateName, name: t.name })), url)
      setLinks((prev) => {
        const byId = new Map((prev || []).map((l) => [l.id, l]))
        for (const r of rows) byId.set(r.id, r)
        return [...byId.values()]
      })
      if (targets.length > 1) setSelected(new Set())
      setLinkDialog(null)
      linkDone(targets.length > 1 ? `Ссылка на документ прикреплена к ${targets.length} позициям.` : `Ссылка на документ к «${targets[0].name}» сохранена.`)
    } catch (e) {
      setLinkError(e.message)
      if (e.kind === 'locked') reloadContext()
    } finally {
      setLinkBusy(false)
    }
  }
  const removeLink = async () => {
    const { targets } = linkDialog
    const ids = targets.map((t) => t.link?.id).filter(Boolean)
    setLinkBusy(true)
    setLinkError('')
    try {
      await removeLinks(ids)
      const gone = new Set(ids)
      setLinks((prev) => (prev || []).filter((l) => !gone.has(l.id)))
      if (targets.length > 1) setSelected(new Set())
      setLinkDialog(null)
      linkDone(ids.length > 1 ? `Ссылки убраны у ${ids.length} позиций.` : 'Ссылка на документ убрана.')
    } catch (e) {
      setLinkError(e.message)
      if (e.kind === 'locked') reloadContext()
    } finally {
      setLinkBusy(false)
    }
  }

  // Действия строк — через одну стабильную функцию: строки таблицы (memo) перерисовываются только когда
  // меняются их собственные данные, а не при каждом сохранении в соседней строке.
  const actionsRef = useRef(null)
  actionsRef.current = {
    commit,
    retry: retryDraft,
    discard: discardDraft,
    conflict: (row) => setConflict({ key: row.key, intent: { mode: row.draft.mode, value: row.draft.value, estimateName: row.doc, position: row.p }, current: row.rate, position: row.p }),
    acceptVolume,
    history: (row) => setHistoryFor({ position: row.p, rate: row.rate, estimateName: row.doc, key: row.key }),
    removeDuplicates,
    toggleSelect,
    editLink: (key) => openLinkDialog(new Set([key])),
    suggest: (row, anchor) => setSuggest((cur) => (cur?.row.key === row.key ? null : { row, anchor })),
  }
  const act = useCallback((name, ...args) => actionsRef.current[name](...args), [])

  // ── Отрисовка ─────────────────────────────────────────────────────────────────────────────────────
  if (loading) return <div className="sp-loading">Загрузка расценки…</div>
  if (loadError) return <p className="sp-error-text">{loadError}</p>
  if (!ctx) return <p className="sp-error-text">Тендер не найден.</p>

  const draftList = Object.values(drafts).filter((d) => !d.auto)
  const savingCount = draftList.filter((d) => d.status === 'saving' || d.status === 'queued').length
  const failedCount = draftList.filter((d) => d.status === 'error' || d.status === 'conflict').length
  const readOnlyReason = ctx.locked
    ? 'Тендер на материалы завершён — расценки только для чтения. Чтобы изменить, верните тендеру на материалы прежний статус.'
    : !canEditRole ? 'Только просмотр: вводить цены могут снабжение и тендерный отдел (право правки раздела).' : ''
  const fromTab = docViews.length > 0 && docViews.every((d) => d.source.source === 'vor_tab')

  // Колонки: [отметка] № · наименование · ед. · объём · цена · итог · [дата цены] · [документ] · состояние.
  // «Дата цены» — день расценки (миграция 20261023); колонок ещё нет в базе — нет и её, и фильтра по дате.
  const datesOn = rates.length ? rates.some((r) => 'price_date' in r) : !reuseOff
  const colCount = 7 + (linksOn ? 1 : 0) + (selectable ? 1 : 0) + (datesOn ? 1 : 0)
  const shownKeys = items.filter((it) => it.kind === 'row').map((it) => it.row.key)
  const shownSelected = shownKeys.filter((k) => selected.has(k)).length

  // Строка-шапка ВОР: имя, «расценено N из M», сумма, источник и действия, пометки.
  const renderHead = ({ doc: d, open }, first) => {
    const notes = docNotes.get(d.name) || []
    const s = d.source
    const complete = d.positions.length > 0 && d.priced === d.positions.length
    const hasRates = rates.some((r) => r.estimate_name === d.name)
    return (
      <tr key={`head:${d.name}`} className={`sp-section-head${first ? ' is-first' : ''}`}>
        <td colSpan={colCount}>
          <div className="sp-section-line">
            {selectable && (() => {
              const keys = d.positions.map((p) => posKey(d.name, p.k))
              const n = keys.filter((k) => selected.has(k)).length
              return (
                <SelectBox checked={keys.length > 0 && n === keys.length} indeterminate={n > 0 && n < keys.length} disabled={!keys.length}
                  onChange={(on) => setSelectedKeys(keys, on)} label={`Отметить все позиции ВОР «${d.name}»`} />
              )
            })()}
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
              ? <>файл «{s.file_name || 'удалён'}», лист «{s.sheet_name || 'Материалы'}»{s.column_map?.mode === 'code' ? ', строки с кодом «мат.»' : ''}</>
              : <>вкладка «ВОР» карточки тендера</>}
            <span> · загружено {fmtTime(s.parsed_at)}{s.parsed_by ? (nameOf(s.parsed_by) ? `, ${nameOf(s.parsed_by)}` : '') : ' автоматически'}</span>
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
    )
  }
  const renderItem = (it) => {
    if (it.kind === 'head') return renderHead(it.s, it.first)
    if (it.kind === 'empty') return <tr key={`empty:${it.s.doc.name}`}><td colSpan={colCount} className="no-data">В этом ВОР нет позиций</td></tr>
    const { row } = it
    if (!reuseOff) noteSimilar(row)
    return (
      <PriceRow key={row.key} row={row} flash={flash[row.key]} editable={editable} nameOf={nameOf} act={act}
        linksOn={linksOn} link={linksByKey?.get(row.key) || null} selectable={selectable} selected={selected.has(row.key)}
        origin={row.rate?.source_kind ? (origins.get(row.rate.id) || null) : null} datesOn={datesOn} showAuthor={showAuthor}
        similar={!reuseOff && wantsSimilar(row) ? similarOthers(row, similar.get(row.key) || 0) : 0}
        suggestOpen={suggest?.row.key === row.key} />
    )
  }

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
      {(editable ? problems : viewerProblems).map((p, i) => (
        <div key={`${p.doc?.id || p.name}-${i}`} className="sp-banner is-warn sp-problem" role="alert">
          <IconAlert size={16} />
          <span>
            {p.kind === 'older'
              ? <>Файл «{p.doc.file_name}» не загружен: есть более новый файл того же ВОР «{p.name}».</>
              : <>ВОР{p.doc ? <> из файла «{p.doc.file_name}»</> : p.name ? <> «{p.name}»</> : ''} не загрузился: {(PROBLEM_TEXT[p.kind] || PROBLEM_TEXT.error)(p)}</>}
          </span>
          {editable && p.doc && ['no_sheet', 'no_header', 'empty', 'no_material_codes'].includes(p.kind) && (
            <button type="button" className="sp-link-btn" onClick={() => setMappingFile(p.doc)}>Указать лист и колонки</button>
          )}
          {editable && p.doc && (p.kind === 'error' || p.kind === 'broken') && <button type="button" className="sp-link-btn" onClick={() => retryFile(p.doc)}>Повторить</button>}
        </div>
      ))}
      {pendingForViewer.length > 0 && (
        <div className="sp-banner" role="status">
          <IconRefresh size={16} />
          <span>
            Файлы ВОР ещё не загружены в расценку: {pendingForViewer.map((j) => `«${j.doc.file_name}»`).join(', ')}.
            {importState ? ' Загрузятся сами в течение 10 минут.' : ' Загрузятся сами, когда тендер откроет снабжение или тендерный отдел.'}
          </span>
        </div>
      )}
      {notice && (
        <div className="sp-banner is-warn" role="alert">
          <IconAlert size={16} /><span>{notice}</span>
          <button type="button" className="sp-link-btn" onClick={() => setNotice('')}>Скрыть</button>
        </div>
      )}
      {fromTab && (
        <p className="sp-muted sp-source-hint">Файлов ВОР с листом «Материалы» или колонкой «КОД» в «ВОРах и РД» нет — позиции взяты из вкладки «ВОР» карточки тендера: строки с кодом «мат.».</p>
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
            {datesOn && (
              <div className={`sp-date-filter${dateFrom || dateTo ? ' is-active' : ''}`} role="group" aria-label="Дата цены">
                <span>Дата цены</span>
                <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} aria-label="Дата цены: с" />
                <span aria-hidden="true">—</span>
                <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} aria-label="Дата цены: по" />
                {(dateFrom || dateTo) && (
                  <button type="button" className="sp-link-btn" onClick={() => { setDateFrom(''); setDateTo('') }}>сбросить</button>
                )}
              </div>
            )}
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

          {/* Строка состояния постоянной высоты: «сохраняем / всё сохранено / не сохранено» и подстановка цены —
              без плашек над таблицей, которые сдвигали строки под курсором. */}
          {editable && (
            <div className="sp-statusbar" role="status" aria-live="polite">
              {failedCount > 0 ? (
                <span className="sp-save-status is-error"><IconAlertCircle size={16} /> Не сохранено: {failedCount} — строки с красным значком, нажмите на значок, чтобы повторить</span>
              ) : savingCount > 0 ? (
                <span className="sp-save-status is-saving"><IconClock size={16} /> Сохраняем…</span>
              ) : lastSavedAt ? (
                <span className="sp-save-status is-ok"><IconCheck size={16} /> Все цены сохранены · {fmtClock(lastSavedAt)}</span>
              ) : (
                <span className="sp-save-status sp-muted">Цены сохраняются сами — через секунду после ввода или при переходе в другое поле</span>
              )}
              {fillNote && <span className="sp-fill-note">{fillNote}</span>}
              {reuseNote && !fillNote && <span className="sp-fill-note">{reuseNote}</span>}
              {selectable && selected.size > 0 && (
                <span className="sp-sel-bar">
                  <span>Отмечено: <b className="ui-num">{selected.size}</b></span>
                  <button type="button" className="btn-secondary sp-sel-action" onClick={() => openLinkDialog(selected)}>
                    <IconLink size={16} /> Ссылка на документ
                  </button>
                  <button type="button" className="sp-link-btn" onClick={() => setSelected(new Set())}>Снять отметку</button>
                </span>
              )}
            </div>
          )}

          <div ref={tableWrapRef} className={`table-container sp-table-wrap${virtual ? ' is-virtual' : ''}`}>
            <table className={`data-table sp-table${linksOn ? ' has-links' : ''}${datesOn ? (showAuthor ? ' has-dates has-authors' : ' has-dates') : ''}`}>
              <colgroup>
                {selectable && <col className="sp-c-sel" />}
                <col className="sp-c-num" /><col className="sp-c-name" /><col className="sp-c-unit" /><col className="sp-c-vol" />
                <col className="sp-c-price" /><col className="sp-c-total" />
                {datesOn && <col className="sp-c-date" />}
                {linksOn && <col className="sp-c-doc" />}
                <col className="sp-c-state" />
              </colgroup>
              <thead>
                <tr>
                  {selectable && (
                    <th className="sp-sel">
                      <SelectBox checked={shownKeys.length > 0 && shownSelected === shownKeys.length}
                        indeterminate={shownSelected > 0 && shownSelected < shownKeys.length} disabled={!shownKeys.length}
                        onChange={(on) => setSelectedKeys(shownKeys, on)} label="Отметить все показанные позиции" />
                    </th>
                  )}
                  <th>№</th>
                  <th>Наименование</th>
                  <th>Ед. изм.</th>
                  <th className="ui-money">Объём</th>
                  <th className="ui-money" title="Как в листе «Материалы» ВОР: цена с учётом доставки и НДС">Цена за ед. с доставкой и НДС, ₽</th>
                  <th className="ui-money" title="Объём × цена за единицу, с НДС">Итого с НДС, ₽</th>
                  {datesOn && (
                    <th title={showAuthor ? 'День расценки (по Москве) и кто поставил цену' : 'День расценки — когда ввели или изменили цену (по Москве)'}>
                      {showAuthor ? 'Дата цены, кто' : 'Дата цены'}
                    </th>
                  )}
                  {linksOn && <th title="Ссылка на чек, счёт или КП поставщика">Документ</th>}
                  <th><span className="ui-sr-only">Состояние</span></th>
                </tr>
              </thead>
              {virtual
                ? <VirtualTableBody rowCount={items.length} renderRow={(i) => renderItem(items[i])} colSpan={colCount} scrollRef={tableWrapRef} rowHeight={44} />
                : <tbody>{items.map(renderItem)}</tbody>}
              <tfoot>
                <tr>
                  <td colSpan={selectable ? 5 : 4}>Итого{docViews.length > 1 ? ` по ${docViews.length} ВОР` : ''} · расценено <span className="ui-num">{grand.priced}</span> из <span className="ui-num">{grand.positions}</span></td>
                  <td />
                  <td className="ui-money"><b>{formatAmount(grand.total)}</b></td>
                  {datesOn && <td />}
                  {linksOn && <td />}
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
        <Suspense fallback={null}>
          <SupplyImportDialog
            mainId={mainId}
            files={[mappingFile]}
            sources={sources}
            onClose={() => setMappingFile(null)}
            onSaved={async ({ close }) => {
              failedFiles.current.delete(mappingFile.id)
              forgetFailure(mappingFile)
              try { await reloadData(mainId) } catch (e) { setNotice(e.message) }
              setProblems((prev) => prev.filter((p) => p.doc?.id !== mappingFile.id))
              if (close) setMappingFile(null)
            }}
          />
        </Suspense>
      )}
      {suggest && (
        <SupplySuggestMenu anchor={suggest.anchor} mainId={mainId} row={suggest.row} editable={editable}
          currentSourceId={rateIn(ratesRef.current, suggest.row.key)?.source_rate_id || null}
          onPick={(s) => pickSuggestion(suggest.row, s)} onClose={closeSuggest} />
      )}
      {linkDialog && (
        <SupplyLinkDialog targets={linkDialog.targets} busy={linkBusy} error={linkError}
          onSave={saveLink} onRemove={removeLink} onClose={() => { if (!linkBusy) setLinkDialog(null) }} />
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

// Строка перерисовывается, только когда меняются её позиция, цена, ввод, подсветка или номер.
const samePriceRow = (a, b) => a.row.p === b.row.p && a.row.rate === b.row.rate && a.row.draft === b.row.draft
  && a.row.gi === b.row.gi && a.row.index === b.row.index && a.row.doc === b.row.doc
  && a.row.duplicates.length === b.row.duplicates.length
  && a.flash === b.flash && a.editable === b.editable && a.nameOf === b.nameOf && a.act === b.act
  && a.linksOn === b.linksOn && a.link === b.link && a.selectable === b.selectable && a.selected === b.selected
  && a.origin === b.origin && a.similar === b.similar && a.suggestOpen === b.suggestOpen
  && a.datesOn === b.datesOn && a.showAuthor === b.showAuthor

const PriceRow = memo(function PriceRow({ row, flash, editable, nameOf, act, linksOn, link, selectable, selected, origin, similar, suggestOpen, datesOn, showAuthor }) {
  const { p, draft, view, index, gi } = row
  const mixed = !!p.units
  const noVolume = !mixed && !(view.volume > 0)
  const totalDisabled = !editable || mixed || noVolume
  return (
    <tr
      className={[
        !view.priced && 'is-unpriced',
        (flash?.kind === 'remote' || flash?.kind === 'auto') && 'is-remote',
        draft?.status === 'error' && 'is-error',
        draft?.status === 'conflict' && 'is-conflict',
        selected && 'is-selected',
      ].filter(Boolean).join(' ')}
    >
      {selectable && (
        <td className="sp-sel" data-label="">
          <SelectBox checked={selected} onChange={() => act('toggleSelect', row.key)} label={`Отметить: ${p.name} (ВОР «${row.doc}»)`} />
        </td>
      )}
      <td className="ui-rownum" data-label="№">{index + 1}</td>
      <td className="sp-name" data-label="Наименование">
        <span>{p.name}</span>
        {mixed && <span className="sp-hint">разные ед. изм.: цена одна на все строки ВОР, сумма — по каждой</span>}
        {noVolume && (
          <span className="sp-hint">
            {p.volume == null ? 'объёма в ВОР нет' : 'объём в ВОР — 0'}: вводится только цена за единицу, итог не посчитать
          </span>
        )}
        {row.duplicates.length > 0 && (
          <span className="sp-hint is-warn">
            ещё цен на это наименование: {row.duplicates.length} (из Excel)
            {editable && <button type="button" className="sp-link-btn" onClick={() => act('removeDuplicates', row)}>оставить последнюю</button>}
          </span>
        )}
        {row.rate?.source_kind && !draft && <OriginHint rate={row.rate} origin={origin} />}
        {similar > 0 && (
          <span className="sp-hint">
            <button type="button" className={`sp-similar-btn${suggestOpen ? ' is-open' : ''}`} aria-haspopup="dialog" aria-expanded={suggestOpen}
              aria-label={`Похожие цены других позиций: ${similar}. ${p.name} (ВОР «${row.doc}»)`}
              onClick={(e) => act('suggest', row, e.currentTarget)}>
              {row.rate?.source_kind ? 'другие похожие цены' : 'похожие цены'}: <span className="ui-num">{similar}</span> <IconChevronDown size={14} />
            </button>
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
          onCommit={(raw) => act('commit', row, 'unit', raw)}
        />
      </td>
      <td className="sp-input-cell" data-label="Итого с НДС, ₽">
        <SupplyMoneyCell
          value={view.total}
          derived={view.primary === 'unit' && view.priced}
          disabled={totalDisabled}
          cellId={`total-${gi}`}
          label={`Сумма: ${p.name} (ВОР «${row.doc}»)`}
          placeholder={editable && mixed ? 'разные ед.' : editable && noVolume ? 'нет объёма' : '—'}
          title={mixed ? 'Сумму не ввести: у позиции разные единицы измерения'
            : noVolume ? 'Сумму не ввести: в ВОР у позиции нет объёма — введите цену за единицу'
              : view.primary === 'unit' && view.priced ? 'Посчитано из цены: цена × объём' : undefined}
          invalid={draft?.status === 'error' && draft.mode === 'total'}
          onCommit={(raw) => act('commit', row, 'total', raw)}
        />
      </td>
      {datesOn && (
        <td className="sp-date" data-label="Дата цены">
          <PriceDateCell rate={draft ? null : row.rate} showAuthor={showAuthor} nameOf={nameOf} origin={origin} />
        </td>
      )}
      {linksOn && (
        <td className="sp-doc" data-label="Документ">
          <LinkCell link={link} editable={editable} name={p.name} doc={row.doc} nameOf={nameOf} onEdit={() => act('editLink', row.key)} />
        </td>
      )}
      <td className="sp-state" data-label="">
        <RowState row={row} flash={flash} editable={editable} nameOf={nameOf} act={act} />
      </td>
    </tr>
  )
}, samePriceRow)

// Кто поставил цену — для администратора: свой ввод, импорт Excel или «Взять» — вошедший (price_by, до миграции —
// последний, кто менял строку); подставленная сама из другого тендера — «автоматически» (автор исходной цены — в
// подсказке и в выгрузке). Цены, загруженные до 16.10.2026, автора не знают: журнала цен тогда не было.
const AUTHOR_UNKNOWN = 'не записан'
function authorText(rate, origin, nameOf) {
  if (rate.source_kind === 'auto') {
    const src = nameOf(origin?.source_price_by)
    return `автоматически${src ? ` (цену поставил ${src})` : ''}`
  }
  const id = rate.price_by ?? rate.updated_by
  return id ? (nameOf(id) || '—') : AUTHOR_UNKNOWN
}

// Дата цены (день расценки) — у всех; администратору — и кто поставил.
function PriceDateCell({ rate, showAuthor, nameOf, origin }) {
  if (!rate) return <span className="sp-muted">—</span>
  const date = fmtPriceDate(rate.price_date)
  const author = showAuthor ? authorText(rate, origin, nameOf) : ''
  const title = [date && `день расценки ${date}`, rate.source_kind === 'pick' && 'цена взята из похожих',
    author && (author === AUTHOR_UNKNOWN ? 'кто поставил — не записан: цена загружена до 16.10.2026, когда автор не записывался' : `поставил: ${author}`)]
    .filter(Boolean).join(' · ')
  return (
    <span className="sp-date-cell" title={title || undefined}>
      <span className="ui-num">{date || '—'}</span>
      {showAuthor && (
        <span className={`sp-author${rate.source_kind === 'auto' ? ' is-auto' : ''}${author === AUTHOR_UNKNOWN ? ' is-unknown' : ''}`}>
          {rate.source_kind === 'auto' ? 'автоматически' : author}
        </span>
      )}
    </span>
  )
}

// Откуда цена: скопирована из другого тендера сама (то же наименование) или выбрана из похожих. День расценки —
// исходной цены; старше 3 месяцев — пометка (такая цена больше никуда сама не подставится).
function OriginHint({ rate, origin }) {
  const [copied, setCopied] = useState(false)
  const date = rate.price_date
  const tender = origin?.tender_number != null ? `тендера № ${origin.tender_number}` : 'другого тендера'
  const title = [origin?.material_name && `«${origin.material_name}»`, origin?.object_name, origin?.estimate_name && `ВОР «${origin.estimate_name}»`,
    date && `день расценки ${fmtPriceDate(date)}`].filter(Boolean).join(' · ')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(origin.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* без доступа к буферу — путь виден в подсказке */ }
  }
  return (
    <span className="sp-hint sp-origin" title={title || undefined}>
      {rate.source_kind === 'pick'
        ? <>цена похожей позиции{origin?.material_name ? <> «{origin.material_name}»</> : null} из {tender}</>
        : <>цена из {tender}</>}
      {origin?.object_name && <> · {origin.object_name}</>}
      {date && <> · от <span className="ui-num">{fmtPriceDate(date)}</span></>}
      {date && !isFreshPriceDate(date) && <span className="sp-origin-stale"> · старше 3 месяцев</span>}
      {origin?.url && (
        <>
          {' · документ: '}
          {isWebLink(origin.url)
            ? <a href={origin.url} target="_blank" rel="noopener noreferrer" className="link" title={origin.url}>Открыть</a>
            : <button type="button" className="link sp-doc-copy" onClick={copy} title={`${origin.url} — сетевой путь, нажмите, чтобы скопировать`}>{copied ? 'Скопировано' : 'Скопировать'}</button>}
        </>
      )}
    </span>
  )
}

// Состояние строки — значки с подписью для диктора, по трём постоянным местам: сохраняется / сохранено
// (галочка остаётся, пока цена есть) / не сохранено / изменено другим; объём изменился или «отменить ввод»;
// история цены.
function RowState({ row, flash, editable, nameOf, act }) {
  const { draft, rate, view } = row
  let status = null
  let middle = null
  if (draft?.status === 'saving' || draft?.status === 'queued') {
    status = <span className="sp-st is-saving" role="img" aria-label="Сохраняется" title="Сохраняется"><IconClock size={16} /></span>
  } else if (draft?.status === 'conflict') {
    status = (
      <button type="button" className="sp-icon-btn is-warn" onClick={() => act('conflict', row)} aria-label="Цену изменил другой пользователь — выбрать значение" title="Цену изменил другой пользователь — выбрать значение">
        <IconAlert size={16} />
      </button>
    )
  } else if (draft?.status === 'error') {
    const canRetry = draft.kind === 'retry' || draft.kind === 'stored' || draft.kind === 'error'
    status = canRetry
      ? (
        <button type="button" className="sp-icon-btn is-error" onClick={() => act('retry', row.key)} aria-label={`Не сохранено: ${draft.message}. Повторить`} title={`Не сохранено: ${draft.message}. Нажмите, чтобы повторить`}>
          <IconAlertCircle size={16} />
        </button>
      )
      : <span className="sp-st is-error" role="img" title={draft.message} aria-label={`Не сохранено: ${draft.message}`}><IconAlertCircle size={16} /></span>
    middle = <button type="button" className="sp-icon-btn" onClick={() => act('discard', row.key)} aria-label="Отменить ввод" title="Отменить ввод">×</button>
  } else if (rate) {
    const who = nameOf(rate.updated_by)
    const text = flash?.kind === 'auto'
      ? `Сохранено: подставлено из ВОР «${flash.from}» — такая же позиция`
      : flash?.kind === 'remote'
        ? `Изменил(а) ${nameOf(flash.by) || 'другой пользователь'}${flash.at ? ` в ${fmtTime(flash.at)}` : ''}`
        : `Сохранено${rate.updated_at ? ` ${fmtTime(rate.updated_at)}` : ''}${who ? `, ${who}` : ''}`
    const fresh = flash?.kind === 'saved' || flash?.kind === 'auto'
    status = <span className={`sp-st is-saved${fresh ? ' is-fresh' : ''}`} role="img" aria-label={text} title={text}><IconCheck size={16} /></span>
  }
  if (view.volumeChanged && !draft) {
    const text = `Объём изменился: было ${fmtVolume(rate.volume_at_input)}, стало ${fmtVolume(view.volume)}. Цена за единицу та же, сумма пересчитана`
    middle = editable
      ? <button type="button" className="sp-icon-btn is-warn" onClick={() => act('acceptVolume', row)} aria-label={`${text}. Принять`} title={`${text}. Нажмите, чтобы принять`}><IconAlert size={16} /></button>
      : <span className="sp-st is-warn" role="img" title={text} aria-label={text}><IconAlert size={16} /></span>
  }
  const history = (rate || draft?.status === 'conflict') && (
    <button type="button" className="sp-icon-btn" onClick={() => act('history', row)} aria-label={`История цены: ${row.p.name}`} title="История цены">
      <IconHistory size={16} />
    </button>
  )
  return (
    <div className="sp-state-inner">
      <span className="sp-slot">{status}</span>
      <span className="sp-slot">{middle}</span>
      <span className="sp-slot">{history}</span>
    </div>
  )
}

// Отметка строки / ВОР / всех показанных; indeterminate — отмечена часть.
function SelectBox({ checked, indeterminate = false, disabled = false, onChange, label }) {
  const ref = useRef(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate }, [indeterminate])
  return (
    <input ref={ref} type="checkbox" className="sp-select" checked={checked} disabled={disabled} aria-label={label} title={label}
      onChange={(e) => onChange(e.target.checked)} />
  )
}

// Ссылка на документ позиции — как «Ссылка на КП» в реестре тендеров на материалы: есть — «Открыть» (адрес http(s),
// новая вкладка) или «Скопировать» (сетевой путь браузер не откроет), адрес — в подсказке; правка — карандаш. Нет —
// «+ ссылка» у того, у кого право правки, иначе «—».
function LinkCell({ link, editable, name, doc, nameOf, onEdit }) {
  const [copied, setCopied] = useState(false)
  if (!link) {
    return editable
      ? <button type="button" className="tp-add-link" onClick={onEdit} title="Добавить ссылку на документ"
          aria-label={`Прикрепить ссылку на документ: ${name} (ВОР «${doc}»)`}>+ ссылка</button>
      : <span className="sp-muted">—</span>
  }
  const who = nameOf(link.updated_by)
  const title = `${link.url}${link.updated_at ? ` · ${fmtTime(link.updated_at)}` : ''}${who ? `, ${who}` : ''}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* без доступа к буферу — путь виден в подсказке */ }
  }
  return (
    <span className="sp-doc-cell">
      {isWebLink(link.url)
        ? <a href={link.url} target="_blank" rel="noopener noreferrer" className="link" title={title}
            aria-label={`Открыть документ к «${name}»`}>Открыть</a>
        : <button type="button" className="link sp-doc-copy" onClick={copy} title={`${title} — сетевой путь, нажмите, чтобы скопировать`}
            aria-label={`Скопировать путь к документу «${name}»`}>{copied ? 'Скопировано' : 'Скопировать'}</button>}
      {editable && (
        <button type="button" className="sp-icon-btn sp-doc-edit" onClick={onEdit} title="Изменить ссылку"
          aria-label={`Изменить ссылку на документ: ${name} (ВОР «${doc}»)`}>
          <IconPencil size={14} />
        </button>
      )}
    </span>
  )
}
