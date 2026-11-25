import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import {
  loadTenderFiles, downloadFileBytes, loadServerPositions, loadMyRates, loadMyRateHistory, saveRates, loadFormFields, loadMyForm, loadBidFiles,
  loadVorSuperseded, saveForm, VOR_CATEGORIES, loadVorChanges, loadSupplyAccess, loadSupplyPrices, requestSupplyPrices, takeSupplyPrices,
  bidFileUrl, bidFileUrlAdmin,
} from '../../services/contractorBids'
import { vatFromAnswers, vatField, vatIncluded, vatLabel } from '../../utils/bidForm'
import { currentVorFiles } from '../../utils/bidFiles'
import { effectiveAnswers } from '../../utils/bidFormLinks'
import { rateKey, BID_KIND_LABEL } from '../../utils/bidPrice'
import { buildBidView, heldBackFiles, vorChanges, vorTotals, supplyByPosition, carryTargets } from '../../utils/bidSitePricing'
import { isWorkbookFileName } from '../../utils/vorFiles'
import { formatAmount } from '../../utils/money'
import { downloadS3File, downloadVorFile, downloadSignedFile } from '../FileDownload'
import BidPositionsTable from './BidPositionsTable'
import BidStructureView from './BidStructureView'
import BidFormPanel from './BidFormPanel'
import BidVorSummary from './BidVorSummary'
import BidSupplyBar from './BidSupplyBar'
import './BidWorkspace.css'

const BidImportDialog = lazy(() => import('./BidImportDialog'))

// Расценка ВОР подрядчиком в кабинете (миграции 20261102, 20270301). Решение пользователя 24.11.2026: расценка на сайте — основной
// путь; как только у организации есть доступ к тендеру (участник или заявка), сразу видны ведомости ВОР и их позиции с ценами.
// Файл — дополнительно: «Загрузить файл с ценами» расценивает всё разом, «Скачать с моими ценами» — выгрузка; «Скачать ВОР» — файл отдела.
//
// Позиции — разбор ВОР службой osp-api (bid_positions, без скачивания и разбора книги в браузере); файл, который служба ещё не
// разобрала (или не смогла), подрядчик от администратора разбирает в браузере (у него есть доступ к файлу), учётка с регистрации ждёт
// службу (serverOnly). Просмотр от имени подрядчика (previewCounterpartyId) — разбор в браузере: функции кабинета отказывают
// администратору.
//
// Цена — одна на позицию тендера (вид + наименование + ед. изм.), пишется сама (через SAVE_DELAY_MS после ввода, порцией);
// отдел видит цены сразу. Суммы — по каждой ведомости (объём позиции в ней) и итог.
//
// Что изменилось в ВОР — по прежней версии ведомости (bid_vor_changes): подрядчик изменения не принимает — их подтверждает отдел;
// новая версия, которую отдел ещё не подтвердил, в расценку не входит (heldBackFiles). Цены снабжения — с разрешения отдела
// (BidSupplyBar): цену берёт база (bid_supply_take). Нет функций (база раньше 20270301) — без этих блоков, расценка как была.
//
// canEdit — тендер открыт и у организации есть доступ (участник или заявка не отклонена): иначе только просмотр.

const SAVE_DELAY_MS = 600

// Разобранные в браузере файлы — на время открытой страницы: переключение между тендерами не скачивает их заново.
const parsedCache = new Map()
async function parseInBrowser(f) {
  const cacheKey = `${f.s3_key}|${f.size_bytes || ''}`
  if (parsedCache.has(cacheKey)) return parsedCache.get(cacheKey)
  // Библиотека Excel — только здесь: с позициями от службы кабинет её не загружает.
  const [{ readBidFileBytes }, bytes] = await Promise.all([import('../../utils/bidVor'), downloadFileBytes(f.s3_key)])
  // Разбор большой книги занимает время — даём странице отрисоваться перед ним.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const result = readBidFileBytes(bytes)
  if (!result.error) parsedCache.set(cacheKey, result)
  return result
}

const fileTitle = (name) => String(name || '').replace(/\.(xlsx|xlsm|xls)$/i, '')
const byTitle = (a, b) => fileTitle(a.file_name).localeCompare(fileTitle(b.file_name), 'ru', { numeric: true })

const PARSE_ERROR = {
  broken: 'файл не открылся',
  no_positions: 'не нашли листы «Материалы» / «Работы» или таблицу ВОР с колонкой «КОД»',
  too_large: 'файл слишком большой',
  too_many: 'слишком много позиций',
  timeout: 'разбор занял слишком много времени',
  memory: 'разбор занял слишком много времени',
  parser: 'файл не открылся',
  missing: 'файла нет в хранилище',
}

// Позиции нет в ВОР (отдел заменил ведомость, пока страница была открыта): база отказывает всей порции. Такие строки отсеиваются
// делением порции пополам — остальные цены записываются, устаревшие из очереди уходят (иначе одна строка держала бы все и
// повторялась бы бесконечно).
const isStalePosition = (e) => String(e?.code || '') === '22023' && /Позиции нет в ВОР/.test(String(e?.message || ''))
// Ошибки, которые повтором не лечатся (приём закрыт, нет доступа, неверные данные): ждём человека, а не повторяем каждые 600 мс.
const PERMANENT_SAVE = new Set(['42501', '22023', 'P0001', 'P0002'])
async function saveIsolating(tenderId, rows, stale) {
  try {
    await saveRates(tenderId, rows)
  } catch (e) {
    if (!isStalePosition(e)) throw e
    if (rows.length === 1) { stale.push(rows[0]); return }
    const mid = rows.length >> 1
    await saveIsolating(tenderId, rows.slice(0, mid), stale)
    await saveIsolating(tenderId, rows.slice(mid), stale)
  }
}

const rateEntry = (r) => ({
  price: r.price == null ? null : Number(r.price), note: r.note || '', source: r.source, updated_at: r.updated_at,
  kind: r.kind, item_key: r.item_key, unit_key: r.unit_key || '', name: r.name, unit: r.unit, volume: r.volume == null ? null : Number(r.volume),
})

export default function BidWorkspace({
  tender, canEdit, counterpartyName, counterpartyId = null, tenderNumbers, onSummary, serverOnly = false, previewCounterpartyId = null,
  companyCard, companyAnswers, onCompanyAnswers,
}) {
  const tenderId = tender.id
  const preview = !!previewCounterpartyId
  const ownCp = previewCounterpartyId || counterpartyId
  // Ведомости: files — актуальные (без заменённых новой версией); server — разбор службы по id; meta — bid_vor_changes по id
  // (null — функции нет).
  const [vor, setVor] = useState({ files: null, server: new Map(), meta: null, error: '' })
  const [browser, setBrowser] = useState({}) // id → { status, result?, error? } — разбор в браузере
  const [vorError, setVorError] = useState('')
  const [rates, setRates] = useState(() => new Map())
  const [ratesState, setRatesState] = useState('loading') // loading | ok | error
  const [history, setHistory] = useState(null)
  const [tab, setTab] = useState('material')
  const [vorId, setVorId] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [save, setSave] = useState({ busy: false, failed: 0, error: '', stale: false, savedAt: null })
  const [exporting, setExporting] = useState(false)
  // Анкета: поля администратора и ответы организации (ставка НДС нужна итогам и до открытия анкеты).
  const [formFields, setFormFields] = useState(null)
  const [answers, setAnswers] = useState({})
  const [previousForm, setPreviousForm] = useState(null)
  const [formError, setFormError] = useState('')
  // Свои файлы с расценками, загруженные прежним способом (20270113): только список для скачивания.
  const [myFiles, setMyFiles] = useState(null)
  // Цены снабжения: access — undefined (нет таблицы) | null (не просили) | строка; prices — Map ключ → цена (только с разрешением).
  const [supply, setSupply] = useState({ access: undefined, prices: null, busy: false, message: '', error: '' })

  // ── Ведомости ВОР ──────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setVor({ files: null, server: new Map(), meta: null, error: '' })
    setBrowser({})
    setVorId('')
    // Заменённые ведомости — вместе со списком: прежняя версия не должна мелькнуть, пока читается отметка.
    const superseded = loadVorSuperseded(tenderId)
    const changes = loadVorChanges(tenderId).catch((e) => { console.error('Изменения ВОР:', e); return null })
    const server = preview ? Promise.resolve(null)
      : loadServerPositions(tenderId).catch((e) => { if (serverOnly) throw e; console.error('Позиции ВОР с сервера:', e); return null })
    const tenderFiles = serverOnly ? Promise.resolve(null)
      : loadTenderFiles(tenderId).catch((e) => { if (preview) throw e; console.error('Файлы ВОР:', e); return null })
    Promise.all([server, tenderFiles, superseded, changes])
      .then(([list, all, sup, ch]) => {
        if (cancelled) return
        let files
        if (all) files = all.filter((f) => VOR_CATEGORIES.includes(f.doc_category) && isWorkbookFileName(f.file_name))
        else if (list) files = list.map(({ id, file_name: fileName }) => ({ id, file_name: fileName }))
        else throw new Error('нет ответа сервера')
        const { current } = currentVorFiles(files, sup)
        setVor({
          files: [...current].sort(byTitle),
          server: new Map((list || []).map((f) => [f.id, f.parsed])),
          meta: ch ? new Map(ch.map((r) => [r.file_id, r])) : null,
          error: '',
        })
      })
      .catch((e) => { if (!cancelled) setVor({ files: [], server: new Map(), meta: null, error: e.message || String(e) }) })
    return () => { cancelled = true }
  }, [tenderId, preview, serverOnly])

  // Файлы, которые служба ещё не разобрала, — в браузере, по одному (разбор книги нагружает страницу).
  useEffect(() => {
    const todo = (vor.files || []).filter((f) => f.s3_key && vor.server.get(f.id)?.status !== 'ok')
    if (!todo.length) return undefined
    let cancelled = false
    ;(async () => {
      for (const f of todo) {
        if (cancelled) return
        setBrowser((p) => ({ ...p, [f.id]: { status: 'loading' } }))
        try {
          const result = await parseInBrowser(f)
          if (cancelled) return
          setBrowser((p) => ({ ...p, [f.id]: result.error ? { status: 'error', error: result.error } : { status: 'ok', result } }))
        } catch (e) {
          if (!cancelled) setBrowser((p) => ({ ...p, [f.id]: { status: 'error', error: 'download', message: e.message } }))
        }
      }
    })()
    return () => { cancelled = true }
  }, [vor])

  const parsedOf = useCallback((f) => {
    const s = vor.server.get(f.id)
    if (s?.status === 'ok') return s
    if (f.s3_key) return browser[f.id] || { status: 'loading' }
    return s || { status: 'pending' }
  }, [vor.server, browser])

  const files = useMemo(() => vor.files || [], [vor.files])
  const okFiles = useMemo(() => files
    .filter((f) => parsedOf(f).status === 'ok')
    .map((f) => ({ id: f.id, title: fileTitle(f.file_name), name: fileTitle(f.file_name), parsed: parsedOf(f).result })), [files, parsedOf])
  const parsing = files.some((f) => parsedOf(f).status === 'loading')
  const preparing = files.some((f) => parsedOf(f).status === 'pending')
  const fileProblems = files.filter((f) => parsedOf(f).status === 'error')

  // Новая версия, которую отдел не подтвердил, — не расценивается и в итог не входит.
  const held = useMemo(() => {
    if (!vor.meta) return new Map()
    return heldBackFiles(okFiles.map((f) => ({ id: f.id, title: f.title, created_at: vor.meta.get(f.id)?.created_at })), vor.meta)
  }, [okFiles, vor.meta])
  const view = useMemo(() => buildBidView(
    okFiles.map((f) => ({ id: f.id, title: f.title, positions: [...(f.parsed.materials || []), ...(f.parsed.works || [])] })),
    new Set(held.keys())), [okFiles, held])
  const titleOf = useMemo(() => new Map(okFiles.map((f) => [f.id, f.title])), [okFiles])
  const changes = useMemo(() => {
    const m = new Map()
    if (!vor.meta) return m
    for (const f of okFiles) {
      const meta = vor.meta.get(f.id)
      if (held.has(f.id) || !meta?.prior_id || !Array.isArray(meta.positions)) continue
      m.set(f.id, { ...vorChanges([...(f.parsed.materials || []), ...(f.parsed.works || [])], meta.positions), priorTitle: meta.prior_title, at: meta.created_at })
    }
    return m
  }, [okFiles, vor.meta, held])
  // Выбранная ведомость пропала (новая версия, другой тендер) — снова все.
  useEffect(() => { if (vorId && !view.vors.some((v) => v.id === vorId && !v.held)) setVorId('') }, [vorId, view.vors])

  // ── Свои файлы прежнего способа ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setMyFiles(null)
    if (!ownCp) return undefined
    loadBidFiles(tenderId, ownCp).then((list) => { if (!cancelled) setMyFiles(list) }).catch(() => {})
    return () => { cancelled = true }
  }, [tenderId, ownCp])

  // ── Анкета ─────────────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setFormFields(null)
    setFormError('')
    Promise.all([loadFormFields(), loadMyForm(tenderId, previewCounterpartyId)])
      .then(([list, { form, previous }]) => {
        if (cancelled) return
        setFormFields(list || [])
        setAnswers(Object.fromEntries(Object.entries(form?.answers || {}).map(([k, v]) => [k, v?.value ?? ''])))
        setPreviousForm(!form && previous ? previous : null)
      })
      .catch((e) => { if (!cancelled) { setFormFields([]); setFormError(e.message || String(e)) } })
    return () => { cancelled = true }
  }, [tenderId, previewCounterpartyId])
  // Что видит подрядчик в анкете: ответы тендера, а у полей о компании — «Моя компания». companyCard / companyAnswers === undefined — ещё
  // читаются: до тех пор ничего не поправляем.
  const companyReady = companyCard !== undefined && companyAnswers !== undefined
  const effective = useMemo(
    () => effectiveAnswers(formFields, answers, companyReady ? companyCard : null, companyReady ? companyAnswers : null),
    [formFields, answers, companyCard, companyAnswers, companyReady])
  const shownAnswers = effective.answers
  const vat = useMemo(() => vatFromAnswers(formFields, shownAnswers), [formFields, shownAnswers])
  const needVat = !!vatField(formFields) && !vat

  // Анкета тендера расходится с «Моей компанией» — поправить её сразу: отдел видит анкету тендера. Один раз на набор правок; без права
  // правки (просмотр от имени подрядчика, приём закрыт) — только показ.
  const syncedRef = useRef('')
  useEffect(() => {
    if (!canEdit || !companyReady || formFields === null) return
    const keys = Object.keys(effective.patch)
    if (!keys.length) return
    const sig = `${tenderId}|${JSON.stringify(effective.patch)}`
    if (syncedRef.current === sig) return
    syncedRef.current = sig
    saveForm(tenderId, effective.patch)
      .then(() => setAnswers((a) => ({ ...a, ...effective.patch })))
      .catch((e) => setFormError(`Сведения из «Моей компании» не записались в анкету тендера: ${e.message || e}`))
  }, [canEdit, companyReady, formFields, effective.patch, tenderId])

  // ── Цены ───────────────────────────────────────────────────────────────────────────────────────────
  const pending = useRef(new Map())
  const timer = useRef(null)
  const inFlight = useRef(false)

  const loadRates = useCallback(async () => {
    setRatesState('loading')
    try {
      const rows = await loadMyRates(tenderId, previewCounterpartyId)
      setRates(new Map(rows.map((r) => [rateKey(r), rateEntry(r)])))
      setRatesState('ok')
    } catch (e) {
      console.error('Цены подрядчика:', e)
      setRatesState('error')
    }
  }, [tenderId, previewCounterpartyId])
  useEffect(() => { loadRates() }, [loadRates])

  // Перечитать цены после записи базой (цены снабжения): набранное и ещё не записанное не теряется.
  const refreshRates = useCallback(async () => {
    const rows = await loadMyRates(tenderId, previewCounterpartyId)
    setRates((prev) => {
      const next = new Map(rows.map((r) => [rateKey(r), rateEntry(r)]))
      for (const k of pending.current.keys()) {
        if (prev.has(k)) next.set(k, prev.get(k))
        else next.delete(k)
      }
      return next
    })
  }, [tenderId, previewCounterpartyId])

  // Свои цены из других тендеров — только тому, кто может ставить цены.
  useEffect(() => {
    if (!canEdit) return undefined
    let cancelled = false
    loadMyRateHistory(tenderId)
      .then((rows) => {
        if (cancelled) return
        const map = new Map()
        for (const r of rows) {
          const k = rateKey(r)
          if (!map.has(k)) map.set(k, { price: Number(r.price), tender_id: r.tender_id, updated_at: r.updated_at })
        }
        setHistory(map)
      })
      .catch(() => { if (!cancelled) setHistory(new Map()) })
    return () => { cancelled = true }
  }, [tenderId, canEdit])

  // ── Запись: очередь позиций, порция раз в SAVE_DELAY_MS ────────────────────────────────────────────
  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    timer.current = null
    if (inFlight.current || pending.current.size === 0) return
    inFlight.current = true
    const batch = [...pending.current.values()]
    pending.current.clear()
    setSave((s) => ({ ...s, busy: true }))
    let rearm = true
    try {
      const stale = []
      await saveIsolating(tenderId, batch, stale)
      setSave({
        busy: false, failed: pending.current.size, savedAt: new Date(), stale: stale.length > 0,
        error: stale.length
          ? `не записано ${stale.length} поз. (${stale.slice(0, 3).map((r) => `«${r.name}»`).join(', ')}${stale.length > 3 ? ' …' : ''}): их нет в актуальной ВОР — отдел обновил ведомость`
          : '',
      })
    } catch (e) {
      // Не записанное возвращается в очередь, если его не перебили новым вводом; повтор сам — только при сбое связи.
      for (const row of batch) {
        const k = `${row.kind}|${row.key}|${row.unit_key}`
        if (!pending.current.has(k)) pending.current.set(k, row)
      }
      rearm = !PERMANENT_SAVE.has(String(e?.code || ''))
      setSave({ busy: false, failed: pending.current.size, error: e.message || String(e), stale: false, savedAt: null })
    } finally {
      inFlight.current = false
      if (rearm && pending.current.size && !timer.current) timer.current = setTimeout(() => flushRef.current(), SAVE_DELAY_MS)
    }
  }, [tenderId])
  const flushRef = useRef(flush)
  flushRef.current = flush

  useEffect(() => () => { clearTimeout(timer.current); flushRef.current() }, [tenderId])
  useEffect(() => {
    const warn = (e) => {
      if (pending.current.size === 0 && !inFlight.current) return
      flushRef.current()
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  // Дождаться записи очереди (перед тем, как база сама запишет цены снабжения).
  const settle = useCallback(async () => {
    for (let i = 0; i < 50 && (pending.current.size || inFlight.current); i++) {
      if (!inFlight.current) await flushRef.current()
      else await new Promise((r) => setTimeout(r, 100))
    }
  }, [])

  // Править можно, только когда свои цены загружены: иначе запись поверх незагруженных затёрла бы их.
  const editable = canEdit && ratesState === 'ok'

  // Цена и (или) примечание позиции. patch: { price?, note?, source? }. Позиция — из ведомостей или цена без позиции (её убирают).
  const commit = useCallback((position, patch) => {
    if (!editable) return
    setRates((prev) => {
      const next = new Map(prev)
      const cur = next.get(position.key) || { price: null, note: '' }
      const merged = { ...cur, ...patch, updated_at: new Date().toISOString() }
      if (merged.price == null && !String(merged.note || '').trim()) next.delete(position.key)
      else next.set(position.key, merged)
      pending.current.set(position.key, {
        kind: position.kind, key: position.itemKey, unit_key: position.unitKey, name: position.name, unit: position.unit,
        volume: position.volume, price: merged.price, note: String(merged.note || '').trim() || null, source: merged.source || 'manual',
      })
      return next
    })
    setSave((s) => ({ ...s, failed: pending.current.size }))
    clearTimeout(timer.current)
    timer.current = setTimeout(() => flushRef.current(), SAVE_DELAY_MS)
  }, [editable])

  const commitMany = useCallback((list) => {
    for (const { position, patch } of list) commit(position, patch)
  }, [commit])

  // ── Цены снабжения ─────────────────────────────────────────────────────────────────────────────────
  const loadSupply = useCallback(async () => {
    setSupply((s) => ({ ...s, busy: true, error: '' }))
    try {
      const access = await loadSupplyAccess(tenderId, ownCp)
      const prices = access?.status === 'granted' ? await loadSupplyPrices(tenderId, previewCounterpartyId) : null
      setSupply((s) => ({ ...s, access, prices, busy: false }))
    } catch (e) {
      console.error('Цены снабжения:', e)
      setSupply((s) => ({ ...s, busy: false, error: `Цены снабжения не загрузились: ${e.message || e}` }))
    }
  }, [tenderId, ownCp, previewCounterpartyId])
  useEffect(() => {
    setSupply({ access: undefined, prices: null, busy: false, message: '', error: '' })
    loadSupply()
  }, [loadSupply])

  const supplyMap = useMemo(() => supplyByPosition(view.materials, supply.prices), [view.materials, supply.prices])
  const supplyStats = useMemo(() => {
    let missing = 0
    let differ = 0
    for (const [key, price] of supplyMap) {
      const r = rates.get(key)
      if (r?.price == null) missing += 1
      else if (!(r.source === 'supply' && r.price === price)) differ += 1
    }
    return { withPrice: supplyMap.size, missing, differ }
  }, [supplyMap, rates])

  const askSupply = async () => {
    setSupply((s) => ({ ...s, busy: true, error: '', message: '' }))
    try {
      await requestSupplyPrices(tenderId)
      await loadSupply()
      setSupply((s) => ({ ...s, message: 'Просьба отправлена ответственному по тендеру.' }))
    } catch (e) {
      setSupply((s) => ({ ...s, busy: false, error: e.message || String(e) }))
    }
  }

  // Взять цены снабжения: replace — и вместо своих цен. Цену записывает база (браузер её не присылает), затем цены перечитываются.
  const takeSupply = async (positions, replace) => {
    if (!editable || !positions.length) return
    setSupply((s) => ({ ...s, busy: true, error: '', message: '' }))
    try {
      await settle()
      const n = await takeSupplyPrices(tenderId, positions.map((p) => ({ key: p.itemKey, unit_key: p.unitKey, name: p.name, unit: p.unit, volume: p.volume })), replace)
      await refreshRates()
      setSupply((s) => ({ ...s, busy: false, message: n ? `Взято цен снабжения: ${n}.` : 'Цены снабжения не изменились.' }))
    } catch (e) {
      setSupply((s) => ({ ...s, busy: false, error: e.message || String(e) }))
      if (/не разрешил/.test(String(e.message || ''))) loadSupply()
    }
  }
  const takeMissing = () => takeSupply(view.materials.filter((p) => supplyMap.has(p.key) && rates.get(p.key)?.price == null), false)
  const takeAll = () => {
    const list = view.materials.filter((p) => supplyMap.has(p.key) && rates.get(p.key)?.price != null
      && !(rates.get(p.key).source === 'supply' && rates.get(p.key).price === supplyMap.get(p.key)))
    if (!window.confirm(`Заменить ваши цены ценами снабжения у ${list.length} поз. материалов? Ваши прежние цены этих позиций пропадут.`)) return
    takeSupply(list, true)
  }

  // ── Сводка ─────────────────────────────────────────────────────────────────────────────────────────
  const totals = useMemo(() => vorTotals(view, rates), [view, rates])
  useEffect(() => {
    onSummary?.({ priced: totals.total.material.priced + totals.total.work.priced, total: totals.total.total })
  }, [totals, onSummary])

  // Цены без позиции: позицию убрали или переименовали в новой версии ВОР (и не в ведомости, ждущей подтверждения).
  const heldKeys = useMemo(() => {
    const s = new Set()
    for (const f of okFiles) if (held.has(f.id)) for (const p of [...(f.parsed.materials || []), ...(f.parsed.works || [])]) s.add(p.key)
    return s
  }, [okFiles, held])
  // Пока не все ведомости прочитаны — «без позиции» не показываем: позиция может быть в непрочитанной.
  const allRead = !parsing && !preparing && fileProblems.length === 0 && okFiles.length > 0
  const orphans = useMemo(() => {
    if (!allRead) return []
    return [...rates.entries()].filter(([k, r]) => r.price != null && !view.byKey.has(k) && !heldKeys.has(k))
  }, [rates, view.byKey, heldKeys, allRead])
  const carry = useMemo(() => (editable ? carryTargets(orphans, view.positions, rates) : new Map()), [editable, orphans, view.positions, rates])
  const removedByVor = useMemo(() => [...changes.entries()].filter(([, c]) => c.removed.length), [changes])

  const orphanPosition = (key, r) => ({ key, kind: r.kind || key.split('|')[0], itemKey: r.item_key, unitKey: r.unit_key, name: r.name, unit: r.unit, volume: r.volume })
  const moveOrphan = (key, r, target) => {
    commit(target, { price: r.price, source: 'manual', note: r.note || rates.get(target.key)?.note || '' })
    commit(orphanPosition(key, r), { price: null, note: '' })
  }
  const dropOrphan = (key, r) => {
    if (!window.confirm(`Убрать вашу цену «${r.name}» (${formatAmount(r.price)} ₽)? Этой позиции больше нет в ВОР.`)) return
    commit(orphanPosition(key, r), { price: null, note: '' })
  }

  const historyHits = useMemo(() => {
    if (!history?.size || !editable) return []
    return view.positions.filter((p) => rates.get(p.key)?.price == null && history.has(p.key))
  }, [history, view.positions, rates, editable])
  const applyHistory = () => {
    if (!historyHits.length) return
    if (!window.confirm(`Подставить ваши цены из прошлых тендеров в ${historyHits.length} поз. без цены? Их можно будет поправить.`)) return
    commitMany(historyHits.map((p) => ({ position: p, patch: { price: history.get(p.key).price, source: 'history' } })))
  }

  // Ключ файла есть только у подрядчика от администратора; учётке с регистрации файл отдаёт сервер по id.
  const downloadVor = async (f) => {
    setVorError('')
    try {
      if (f.s3_key) await downloadS3File(f.s3_key, f.file_name)
      else await downloadVorFile(f.id, `${f.file_name}.xlsx`)
    } catch (e) {
      setVorError(`«${f.file_name}» не скачался: ${e.message || e}`)
    }
  }
  const downloadMine = (f) => downloadSignedFile(`bidfile:${f.id}`, f.file_name, () => (preview ? bidFileUrlAdmin(f.id) : bidFileUrl(f.id)))
    .catch((e) => setVorError(`«${f.file_name}» не скачался: ${e.message || e}`))

  // Выгрузка в Excel с ценами (материалы, работы, лист «КП» каждой ведомости, анкета).
  const exportExcel = async () => {
    setExporting(true)
    try {
      const { downloadBidWorkbook } = await import('../../utils/bidExport')
      const withDocs = (list) => list.map((p) => ({ ...p, docs: p.files.map((id) => titleOf.get(id)).filter(Boolean) }))
      downloadBidWorkbook({
        tender, counterpartyName, rates,
        positions: { materials: withDocs(view.materials), works: withDocs(view.works) },
        files: okFiles.filter((f) => !held.has(f.id)),
        form: formFields?.length ? { fields: formFields, answers: shownAnswers } : null,
      })
    } catch (e) {
      setVorError(`Excel не собрался: ${e.message || e}`)
    } finally {
      setExporting(false)
    }
  }

  // Особые условия «Главного листа» всех ведомостей — без повторов.
  const conditions = useMemo(() => [...new Set(okFiles.flatMap((f) => f.parsed.conditions || []))], [okFiles])

  // ── Отрисовка ──────────────────────────────────────────────────────────────────────────────────────
  if (vor.files === null) return <div className="bid-state">Загрузка ведомостей ВОР…</div>

  const kindCount = (kind) => (kind === 'material' ? view.materials : view.works).length
  const kindMissing = (kind) => totals.total[kind].items - totals.total[kind].priced
  const tabs = [
    { key: 'material', label: BID_KIND_LABEL.material, count: kindCount('material'), missing: kindMissing('material') },
    { key: 'work', label: BID_KIND_LABEL.work, count: kindCount('work'), missing: kindMissing('work') },
    { key: 'kp', label: 'Структура КП' },
    { key: 'form', label: 'Анкета', warn: needVat && canEdit },
  ]
  const shownVors = view.vors.filter((v) => !v.held)
  const allTotal = totals.total.total

  return (
    <div className="bid-ws">
      <div className="bid-summary">
        {/* Суммы — один раз: строка «ИТОГО по всем ВОР» сводки ниже (правило пользователя: одно и то же — один раз). Здесь — ставка НДС. */}
        <div className="bid-summary-cells">
          {formFields && vatField(formFields) && (
            needVat ? (
              <button type="button" className="bid-sum-cell bid-sum-warn" onClick={() => setTab('form')}>
                <span className="bid-sum-label">Ставка НДС</span>
                <span className="bid-sum-value">не указана — выбрать</span>
              </button>
            ) : (
              <div className="bid-sum-cell">
                <span className="bid-sum-label">НДС: {vatLabel(vat)}</span>
                <span className="bid-sum-value">{vat.exempt ? '—' : `в т. ч. ${formatAmount(vatIncluded(allTotal, vat))} ₽`}</span>
              </div>
            )
          )}
        </div>
        <div className="bid-summary-actions">
          {editable && (
            <button type="button" className="cab-btn" onClick={() => setImportOpen(true)} disabled={!view.positions.length}
              title="Свой прайс, КП, счёт или заполненный ВОР — цены встанут к похожим позициям, проверите перед записью">
              Загрузить файл с ценами
            </button>
          )}
          <button type="button" className="cab-btn" onClick={exportExcel} disabled={exporting || !view.positions.length}>
            {exporting ? 'Собираем Excel…' : 'Скачать с моими ценами'}
          </button>
          {editable && historyHits.length > 0 && (
            <button type="button" className="cab-btn" onClick={applyHistory} title="Те же позиции, что вы уже расценивали в других тендерах">
              Мои прошлые цены ({historyHits.length})
            </button>
          )}
        </div>
      </div>

      <SaveLine save={save} canEdit={canEdit} preview={preview} ratesState={ratesState} onRetry={() => flushRef.current()} onReload={loadRates} />

      <BidSupplyBar
        access={supply.access}
        canEdit={editable}
        preview={preview}
        withPrice={supplyStats.withPrice}
        missing={supplyStats.missing}
        differ={supplyStats.differ}
        busy={supply.busy}
        message={supply.message}
        error={supply.error}
        onRequest={askSupply}
        onRefresh={loadSupply}
        onTakeMissing={takeMissing}
        onTakeAll={takeAll}
      />

      {vor.error && <div className="bid-note is-warn">{serverOnly ? 'Позиции ВОР не загрузились' : 'Ведомости ВОР не загрузились'}: {vor.error}</div>}
      {vorError && <div className="bid-note is-warn" role="alert">{vorError}</div>}
      {files.length === 0 && !vor.error && (
        <div className="bid-note">ВОР ещё не опубликован — расценка появится, когда отдел загрузит ведомость в Excel.</div>
      )}
      {parsing && <div className="bid-note">Читаем ведомости ВОР…</div>}
      {preparing && <div className="bid-note">Готовим позиции ВОР: обычно это занимает до 10 минут. Обновите страницу чуть позже.</div>}
      {fileProblems.length > 0 && (
        <div className="bid-note is-warn">
          Не удалось разобрать: {fileProblems.map((f) => `«${fileTitle(f.file_name)}» — ${PARSE_ERROR[parsedOf(f).error] || 'файл не скачался'}`).join('; ')}.
          {' '}Ведомость можно скачать и расценить файлом; сообщите ответственному по тендеру.
          {fileProblems.map((f) => (
            <button key={f.id} type="button" className="bid-link bid-note-act" onClick={() => downloadVor(f)}>Скачать «{fileTitle(f.file_name)}»</button>
          ))}
        </div>
      )}

      {view.vors.length > 0 && (
        <BidVorSummary
          rows={totals.rows}
          total={totals.total}
          selected={vorId}
          onSelect={setVorId}
          changes={changes}
          held={held}
          files={files}
          onDownload={downloadVor}
          vatExempt={!!vat?.exempt}
        />
      )}

      {conditions.length > 0 && (
        <div className="bid-conditions">
          <div className="bid-conditions-title">Особые условия</div>
          <ul>{conditions.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}

      <nav className="bid-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
            className={`bid-tab${tab === t.key ? ' is-active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
            {t.count != null && <span className="bid-tab-count">{t.count}</span>}
            {t.missing > 0 && <span className="bid-tab-missing" title={`Без цены: ${t.missing}`}>без цены {t.missing}</span>}
            {t.warn && <span className="bid-tab-warn" title="Не указана ставка НДС">!</span>}
          </button>
        ))}
      </nav>

      {tab === 'form' && (
        <BidFormPanel
          tenderId={tenderId}
          canEdit={canEdit}
          fields={formFields}
          answers={shownAnswers}
          card={companyReady ? companyCard : null}
          companyAnswers={companyReady ? companyAnswers : null}
          onCompanyAnswers={onCompanyAnswers}
          previous={previousForm}
          error={formError}
          onAnswers={setAnswers}
          onPreviousUsed={() => setPreviousForm(null)}
        />
      )}
      {(tab === 'material' || tab === 'work') && (
        <BidPositionsTable
          key={tab}
          kind={tab}
          positions={tab === 'material' ? view.materials : view.works}
          rates={rates}
          history={history}
          tenderNumbers={tenderNumbers}
          canEdit={editable}
          vors={shownVors}
          vorId={vorId}
          onVorChange={setVorId}
          titleOf={titleOf}
          changes={changes}
          supply={supply.access?.status === 'granted' && supplyMap.size ? supplyMap : null}
          supplyBusy={supply.busy}
          onTakeSupply={(p) => takeSupply([p], true)}
          vatExempt={!!vat?.exempt}
          onCommit={commit}
        />
      )}
      {tab === 'kp' && <BidStructureView files={okFiles.filter((f) => !held.has(f.id))} rates={rates} />}

      {(orphans.length > 0 || removedByVor.length > 0) && (
        <details className="bid-removed" open={orphans.length > 0}>
          <summary>
            Убрано из ВОР в новой версии{orphans.length > 0 ? ` · ваших цен без позиции: ${orphans.length} — в итог не входят` : ''}
          </summary>
          {orphans.length > 0 && (
            <ul className="bid-removed-list">
              {orphans.map(([key, r]) => {
                const target = carry.get(key)
                return (
                  <li key={key}>
                    <span className="bid-removed-name">{r.name || 'позиция'}{r.unit ? `, ${r.unit}` : ''} — ваша цена {formatAmount(r.price)} ₽</span>
                    {target && (
                      <button type="button" className="bid-link" onClick={() => moveOrphan(key, r, target)}>
                        перенести на «{target.name}{target.unit ? `, ${target.unit}` : ''}»
                      </button>
                    )}
                    {editable && <button type="button" className="bid-link" onClick={() => dropOrphan(key, r)}>убрать</button>}
                  </li>
                )
              })}
            </ul>
          )}
          {removedByVor.map(([id, c]) => (
            <div key={id} className="bid-removed-vor">
              <b>«{titleOf.get(id)}»</b> — убрано по сравнению с «{c.priorTitle}»: {c.removed.map((p) => `${p.name}${p.unit ? `, ${p.unit}` : ''}`).join('; ')}
            </div>
          ))}
        </details>
      )}

      {myFiles?.length > 0 && (
        <details className="bid-removed">
          <summary>Ваши файлы с расценками, загруженные раньше: {myFiles.length}</summary>
          <ul className="bid-removed-list">
            {myFiles.map((f) => (
              <li key={f.id}>
                <span className="bid-removed-name">{f.vor_name ? `${f.vor_name}: ` : ''}{f.file_name}</span>
                <button type="button" className="bid-link" onClick={() => downloadMine(f)}>скачать</button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {importOpen && (
        <Suspense fallback={null}>
          <BidImportDialog
            positions={view.positions}
            rates={rates}
            vat={vat}
            onApply={(list) => { commitMany(list); setImportOpen(false) }}
            onClose={() => setImportOpen(false)}
          />
        </Suspense>
      )}
    </div>
  )
}

function SaveLine({ save, canEdit, preview, ratesState, onRetry, onReload }) {
  if (ratesState === 'error') {
    return (
      <div className="bid-save is-error">
        Ваши цены не загрузились. <button type="button" className="bid-link" onClick={onReload}>Повторить</button>
      </div>
    )
  }
  if (preview) return <div className="bid-save">Просмотр от имени подрядчика: цены не записываются.</div>
  if (!canEdit) return <div className="bid-save">Только просмотр: приём предложений закрыт или участие отклонено.</div>
  let text = 'Цены сохраняются сами — отправлять ничего не нужно.'
  let cls = ''
  if (save.busy) text = 'Сохраняем…'
  else if (save.stale) {
    return (
      <div className="bid-save is-error" role="status">
        Остальные цены сохранены, {save.error}.{' '}
        <button type="button" className="bid-link" onClick={() => window.location.reload()}>Обновить страницу</button>
      </div>
    )
  } else if (save.error) { text = `Не сохранено: ${save.failed} — ${save.error}`; cls = ' is-error' }
  else if (save.failed > 0) text = 'Сохраняем…'
  else if (save.savedAt) text = `Все цены сохранены · ${save.savedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
  return (
    <div className={`bid-save${cls}`} role="status">
      {text}
      {save.error && <> <button type="button" className="bid-link" onClick={onRetry}>Повторить</button></>}
    </div>
  )
}
