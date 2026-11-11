import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import {
  loadTenderFiles, downloadFileBytes, loadServerPositions, loadMyRates, loadMyRateHistory, saveRates, loadFormFields, loadMyForm, loadBidFiles,
  loadVorSuperseded, saveForm, VOR_CATEGORIES,
} from '../../services/contractorBids'
import { vatFromAnswers, vatField, vatIncluded, vatLabel } from '../../utils/bidForm'
import { currentVorFiles } from '../../utils/bidFiles'
import { effectiveAnswers } from '../../utils/bidFormLinks'
import { readBidFileBytes, mergeBidFiles, rateKey, BID_KIND_LABEL } from '../../utils/bidVor'
import { isWorkbookFileName } from '../../utils/vorFiles'
import { formatAmount } from '../../utils/money'
import { downloadS3File, downloadVorFile } from '../FileDownload'
import { IconDownload } from '../icons/ActionIcons'
import BidPositionsTable from './BidPositionsTable'
import BidStructureView from './BidStructureView'
import BidFormPanel from './BidFormPanel'
import BidVorFiles from './BidVorFiles'
import './BidWorkspace.css'

const BidImportDialog = lazy(() => import('./BidImportDialog'))

// Расценка ВОР подрядчиком в кабинете (миграция 20261102): позиции — из файлов ВОР тендера («ВОРы и РД»,
// листы «Материалы», «Работы», «КП»), цена — одна на уникальную позицию тендера, пишется сама (через
// SAVE_DELAY_MS после ввода, порцией). Отдел видит цены сразу — отправлять ничего не нужно (решение пользователя).
//
// canEdit — тендер открыт и у организации есть доступ (участник или заявка не отклонена): иначе только просмотр.
//
// serverPositions — подрядчик, зарегистрировавшийся на сайте (миграция 20261204): файлы ему не отдаются, позиции, структуру и
// особые условия присылает сервер (bid_positions), дальше всё то же самое. Сам файл ВОР он скачивает отдельным маршрутом.
//
// Основной путь расценки — файл ВОР тендера (решение пользователя 05.11.2026): кнопка «Скачать ВОР» у каждого файла сверху, заполненный
// файл принимает «Цены из файла»; собранная здесь книга — только маленькая кнопка «Шаблон Excel».
//
// previewCounterpartyId — просмотр от имени подрядчика: администратору правило показывает цены всех организаций, нужны только эти.
//
// Свой ВОР с расценками (миграция 20270113, решение пользователя 11.11.2026): расценка на сайте временно скрыта (SITE_PRICING) — рядом
// с каждой ведомостью подрядчик загружает свой заполненный ВОР, суммы по ведомостям и итог — сводкой как в «Сравнении КП» (BidVorFiles).
// Остаются особые условия и анкета. Таблицы файлов в базе нет (база раньше миграции) — прежняя расценка на сайте, как была.
// Собранной сайтом книги («Шаблон Excel») больше нет: подрядчик заполняет сам файл ВОР отдела.
//
// Только актуальная версия каждой ведомости (миграция 20270114, тендер № 847): файлы, которые снабжение отметило прежней версией
// (как в «Сравнении КП»), не показываются и в расценку не входят; функции нет — все файлы, как раньше.
//
// Анкета и «Моя компания» — одни сведения (миграция 20270115): поля о компании берутся из карточки компании и ответов организации
// (companyCard, companyAnswers — их читает страница), и, если анкета тендера с ними расходится, она сама поправляется — анкета тендера
// то, что видит отдел.

const SAVE_DELAY_MS = 600
// Расценка прямо на сайте (таблицы «Материалы» / «Работы», «Цены из файла», «Структура КП»). Временно скрыта — решение пользователя
// 11.11.2026; вернуть — true: таблицы встанут под блоком своих ВОР. Без миграции 20270113 расценка на сайте показывается и так.
const SITE_PRICING = false

// Разобранные файлы — на время открытой страницы: переключение между тендерами не скачивает их заново.
const parsedCache = new Map()

async function parseFile(f) {
  const cacheKey = `${f.s3_key}|${f.size_bytes || ''}`
  if (parsedCache.has(cacheKey)) return parsedCache.get(cacheKey)
  const bytes = await downloadFileBytes(f.s3_key)
  // Разбор большой книги занимает время — даём странице отрисоваться перед ним.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const result = readBidFileBytes(bytes)
  if (!result.error) parsedCache.set(cacheKey, result)
  return result
}

const fileTitle = (name) => String(name || '').replace(/\.(xlsx|xlsm|xls)$/i, '')

const PARSE_ERROR = {
  broken: 'файл не открылся',
  no_positions: 'не нашли листы «Материалы» / «Работы» или таблицу ВОР с колонкой «КОД»',
  // Разбор на сервере (serverPositions).
  too_large: 'файл слишком большой',
  too_many: 'слишком много позиций',
  timeout: 'разбор занял слишком много времени',
  memory: 'разбор занял слишком много времени',
  parser: 'файл не открылся',
  missing: 'файла нет в хранилище',
}

export default function BidWorkspace({
  tender, canEdit, counterpartyName, counterpartyId = null, tenderNumbers, onSummary, serverPositions = false, previewCounterpartyId = null,
  companyCard, companyAnswers, onCompanyAnswers,
}) {
  const tenderId = tender.id
  const [files, setFiles] = useState(null) // null — загрузка списка
  const [priorOf, setPriorOf] = useState(null) // id прежней версии ведомости → id новой (bid_vor_superseded)
  const [filesError, setFilesError] = useState('')
  const [vorError, setVorError] = useState('')
  const [parsed, setParsed] = useState({}) // id файла → { status, result, error }
  const [rates, setRates] = useState(() => new Map())
  const [ratesState, setRatesState] = useState('loading') // loading | ok | error
  const [history, setHistory] = useState(null)
  const [tab, setTab] = useState('material')
  const [importOpen, setImportOpen] = useState(false)
  const [save, setSave] = useState({ busy: false, failed: 0, error: '', savedAt: null })
  // Анкета: поля администратора и ответы организации (ставка НДС нужна итогам и до открытия анкеты).
  const [formFields, setFormFields] = useState(null)
  const [answers, setAnswers] = useState({})
  const [previousForm, setPreviousForm] = useState(null)
  const [formError, setFormError] = useState('')
  // Свои ВОР с расценками: undefined — читаются, null — таблицы ещё нет (прежняя расценка на сайте), массив — строки.
  const [myFiles, setMyFiles] = useState(undefined)
  const [myFilesError, setMyFilesError] = useState('')
  const ownCp = previewCounterpartyId || counterpartyId

  const loadMyFiles = useCallback(async () => {
    if (!ownCp) { setMyFiles(null); return }
    try {
      setMyFiles(await loadBidFiles(tenderId, ownCp))
      setMyFilesError('')
    } catch (e) {
      setMyFilesError(e.message || String(e))
      setMyFiles((prev) => (prev === undefined ? [] : prev))
    }
  }, [tenderId, ownCp])
  useEffect(() => { setMyFiles(undefined); loadMyFiles() }, [loadMyFiles])
  const fileMode = Array.isArray(myFiles)
  const sitePricing = SITE_PRICING || myFiles === null

  // ── Файлы ВОР ──────────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setFiles(null)
    setPriorOf(null)
    setParsed({})
    setFilesError('')
    // Заменённые ведомости — вместе со списком: прежняя версия не должна мелькнуть, пока читается отметка.
    const superseded = loadVorSuperseded(tenderId)
    if (serverPositions) {
      Promise.all([loadServerPositions(tenderId), superseded])
        .then(([list, sup]) => {
          if (cancelled) return
          const { current, priorOf: prior } = currentVorFiles(list.map(({ id, file_name: fileName }) => ({ id, file_name: fileName })), sup)
          setPriorOf(prior)
          setFiles(current)
          setParsed(Object.fromEntries(list.map((f) => [f.id, f.parsed])))
        })
        .catch((e) => { if (!cancelled) { setFiles([]); setFilesError(e.message || String(e)) } })
      return () => { cancelled = true }
    }
    Promise.all([loadTenderFiles(tenderId), superseded])
      .then(([all, sup]) => {
        if (cancelled) return
        const vor = all.filter((f) => VOR_CATEGORIES.includes(f.doc_category) && isWorkbookFileName(f.file_name))
        const { current, priorOf: prior } = currentVorFiles(vor, sup)
        setPriorOf(prior)
        setFiles(current)
      })
      .catch((e) => { if (!cancelled) { setFiles([]); setFilesError(e.message || String(e)) } })
    return () => { cancelled = true }
  }, [tenderId, serverPositions])

  useEffect(() => {
    if (serverPositions || !files?.length) return undefined
    let cancelled = false
    ;(async () => {
      // По одному: разбор книги нагружает страницу, параллельно — подвисания.
      for (const f of files) {
        if (cancelled) return
        setParsed((p) => ({ ...p, [f.id]: { status: 'loading' } }))
        try {
          const result = await parseFile(f)
          if (cancelled) return
          setParsed((p) => ({ ...p, [f.id]: result.error ? { status: 'error', error: result.error } : { status: 'ok', result } }))
        } catch (e) {
          if (!cancelled) setParsed((p) => ({ ...p, [f.id]: { status: 'error', error: 'download', message: e.message } }))
        }
      }
    })()
    return () => { cancelled = true }
  }, [files, serverPositions])

  const okFiles = useMemo(() => (files || [])
    .filter((f) => parsed[f.id]?.status === 'ok')
    .map((f) => ({ id: f.id, name: fileTitle(f.file_name), parsed: parsed[f.id].result })), [files, parsed])
  const positions = useMemo(() => mergeBidFiles(okFiles), [okFiles])
  const allPositions = useMemo(() => [...positions.materials, ...positions.works], [positions])
  const parsing = (files || []).some((f) => !parsed[f.id] || parsed[f.id].status === 'loading')
  const preparing = (files || []).some((f) => parsed[f.id]?.status === 'pending')

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
  const loadRates = useCallback(async () => {
    setRatesState('loading')
    try {
      const rows = await loadMyRates(tenderId, previewCounterpartyId)
      setRates(new Map(rows.map((r) => [rateKey(r), { price: r.price == null ? null : Number(r.price), note: r.note || '', source: r.source, updated_at: r.updated_at }])))
      setRatesState('ok')
    } catch (e) {
      console.error('Цены подрядчика:', e)
      setRatesState('error')
    }
  }, [tenderId, previewCounterpartyId])
  useEffect(() => { loadRates() }, [loadRates])

  // Свои цены из других тендеров — только тому, кто может ставить цены на сайте.
  useEffect(() => {
    if (!canEdit || !sitePricing) return undefined
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
  }, [tenderId, canEdit, sitePricing])

  // ── Запись: очередь позиций, порция раз в SAVE_DELAY_MS ────────────────────────────────────────────
  const pending = useRef(new Map())
  const timer = useRef(null)
  const inFlight = useRef(false)

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    timer.current = null
    if (inFlight.current || pending.current.size === 0) return
    inFlight.current = true
    const batch = [...pending.current.values()]
    pending.current.clear()
    setSave((s) => ({ ...s, busy: true }))
    try {
      await saveRates(tenderId, batch)
      setSave({ busy: false, failed: pending.current.size, error: '', savedAt: new Date() })
    } catch (e) {
      // Не записанное возвращается в очередь, если его не перебили новым вводом.
      for (const row of batch) {
        const k = `${row.kind}|${row.key}|${row.unit_key}`
        if (!pending.current.has(k)) pending.current.set(k, row)
      }
      setSave({ busy: false, failed: pending.current.size, error: e.message || String(e), savedAt: null })
    } finally {
      inFlight.current = false
      if (pending.current.size && !timer.current) timer.current = setTimeout(() => flushRef.current(), SAVE_DELAY_MS)
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

  // Править можно, только когда свои цены загружены: иначе запись поверх незагруженных затёрла бы их.
  const editable = canEdit && ratesState === 'ok'

  // Цена и (или) примечание позиции. patch: { price?, note?, source? }.
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

  // ── Сводка ─────────────────────────────────────────────────────────────────────────────────────────
  const summary = useMemo(() => {
    const s = { material: { items: 0, priced: 0, total: 0 }, work: { items: 0, priced: 0, total: 0 } }
    for (const p of allPositions) {
      const r = rates.get(p.key)
      const bucket = s[p.kind]
      bucket.items += 1
      if (r?.price != null) {
        bucket.priced += 1
        if (p.volume != null) bucket.total += r.price * p.volume
      }
    }
    s.material.total = Math.round(s.material.total * 100) / 100
    s.work.total = Math.round(s.work.total * 100) / 100
    return s
  }, [allPositions, rates])
  const orphanRates = useMemo(() => {
    if (parsing || preparing || !okFiles.length) return []
    const keys = new Set(allPositions.map((p) => p.key))
    return [...rates.entries()].filter(([k, r]) => !keys.has(k) && r.price != null)
  }, [rates, allPositions, parsing, preparing, okFiles.length])

  useEffect(() => {
    onSummary?.({ priced: summary.material.priced + summary.work.priced, total: summary.material.total + summary.work.total })
  }, [summary, onSummary])

  const historyHits = useMemo(() => {
    if (!history?.size || !editable) return []
    return allPositions.filter((p) => rates.get(p.key)?.price == null && history.has(p.key))
  }, [history, allPositions, rates, editable])
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

  // Особые условия «Главного листа» всех файлов ВОР — без повторов.
  const conditions = useMemo(() => [...new Set(okFiles.flatMap((f) => f.parsed.conditions || []))], [okFiles])

  // ── Отрисовка ──────────────────────────────────────────────────────────────────────────────────────
  if (files === null || myFiles === undefined) return <div className="bid-state">{serverPositions ? 'Загрузка позиций ВОР…' : 'Загрузка файлов ВОР…'}</div>

  const fileProblems = (files || []).filter((f) => parsed[f.id]?.status === 'error')
  const tabs = [
    { key: 'form', label: 'Анкета', warn: needVat && canEdit },
    { key: 'material', label: BID_KIND_LABEL.material, count: positions.materials.length },
    { key: 'work', label: BID_KIND_LABEL.work, count: positions.works.length },
    { key: 'kp', label: 'Структура КП' },
  ]

  const formPanel = (
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
  )

  return (
    <div className="bid-ws">
      {fileMode ? (
        (files.length > 0 || myFiles.length > 0) && (
          <BidVorFiles
            tenderId={tenderId}
            vorFiles={files}
            priorOf={priorOf}
            parsed={parsed}
            myFiles={myFiles}
            canEdit={canEdit}
            preview={!!previewCounterpartyId}
            ownVat={vat}
            counterpartyName={counterpartyName}
            onDownloadVor={downloadVor}
            vorError={vorError}
            onChanged={loadMyFiles}
          />
        )
      ) : files.length > 0 && (
        <div className="bid-vor-files">
          <div className="bid-vor-head">
            <b>{files.length > 1 ? 'Файлы ВОР для расценки' : 'Файл ВОР для расценки'}</b>
            {canEdit && <span>Скачайте ВОР и заполните цены: готовый файл примет кнопка «Цены из файла», а можно вводить цены прямо в таблице ниже.</span>}
          </div>
          <ul className="bid-vor-list">
            {files.map((f) => (
              <li key={f.id} className="bid-vor-file">
                <span className="bid-vor-name" title={f.file_name}>{f.file_name}</span>
                <button type="button" className="cab-btn cab-btn-primary bid-vor-btn" aria-label={`Скачать ВОР «${f.file_name}»`} onClick={() => downloadVor(f)}>
                  <IconDownload size={14} />
                  Скачать ВОР
                </button>
              </li>
            ))}
          </ul>
          {vorError && <div className="bid-note is-warn" role="alert">{vorError}</div>}
        </div>
      )}
      {myFilesError && <div className="bid-note is-warn">Ваши файлы с расценками не загрузились: {myFilesError}</div>}
      {fileMode && !canEdit && (
        <div className="bid-save">
          {previewCounterpartyId ? 'Просмотр от имени подрядчика: файлы не загружаются.' : 'Только просмотр: приём предложений закрыт или участие отклонено.'}
        </div>
      )}

      {sitePricing && (
        <>
          <div className="bid-summary">
            <div className="bid-summary-cells">
              <SummaryCell label="Материалы" s={summary.material} />
              <SummaryCell label="Работы" s={summary.work} />
              <div className="bid-sum-cell bid-sum-total">
                <span className="bid-sum-label">{vat?.exempt ? 'Итого, без НДС' : 'Итого с НДС'}</span>
                <span className="bid-sum-value">{formatAmount(summary.material.total + summary.work.total)} ₽</span>
              </div>
              {formFields && vatField(formFields) && (
                needVat ? (
                  <button type="button" className="bid-sum-cell bid-sum-warn" onClick={() => setTab('form')}>
                    <span className="bid-sum-label">Ставка НДС</span>
                    <span className="bid-sum-value">не указана — выбрать</span>
                  </button>
                ) : (
                  <div className="bid-sum-cell">
                    <span className="bid-sum-label">НДС: {vatLabel(vat)}</span>
                    <span className="bid-sum-value">
                      {vat.exempt ? '—' : `в т. ч. ${formatAmount(vatIncluded(summary.material.total + summary.work.total, vat))} ₽`}
                    </span>
                  </div>
                )
              )}
            </div>
            <div className="bid-summary-actions">
              {editable && (
                <button type="button" className="cab-btn" onClick={() => setImportOpen(true)} disabled={!allPositions.length}>
                  Цены из файла
                </button>
              )}
              {editable && historyHits.length > 0 && (
                <button type="button" className="cab-btn" onClick={applyHistory} title="Те же позиции, что вы уже расценивали в других тендерах">
                  Мои прошлые цены ({historyHits.length})
                </button>
              )}
            </div>
          </div>

          <SaveLine save={save} canEdit={canEdit} preview={!!previewCounterpartyId} ratesState={ratesState} onRetry={() => flushRef.current()} onReload={loadRates} />
        </>
      )}

      {filesError && <div className="bid-note is-warn">{serverPositions ? 'Позиции ВОР не загрузились' : 'Файлы тендера не загрузились'}: {filesError}</div>}
      {files.length === 0 && !filesError && (
        <div className="bid-note">
          {serverPositions ? 'ВОР ещё не опубликован — расценка появится, когда отдел его загрузит.' : 'Файлы ВОР ещё не опубликованы — расценка появится, когда отдел загрузит ВОР в Excel.'}
        </div>
      )}
      {parsing && files.length > 0 && <div className="bid-note">Читаем файлы ВОР…</div>}
      {preparing && <div className="bid-note">Готовим позиции ВОР: обычно это занимает до 10 минут. Обновите страницу чуть позже.</div>}
      {fileProblems.length > 0 && (
        <div className="bid-note is-warn">
          Не удалось разобрать: {fileProblems.map((f) => `«${fileTitle(f.file_name)}» — ${PARSE_ERROR[parsed[f.id].error] || 'файл не скачался'}`).join('; ')}.
          {' '}Сообщите ответственному по тендеру.
        </div>
      )}
      {sitePricing && orphanRates.length > 0 && (
        <div className="bid-note is-warn">
          Цены без позиции в ВОР: {orphanRates.length} — позиции убрали или переименовали в новой версии ВОР.
          В расчёт они не входят.
        </div>
      )}

      {conditions.length > 0 && (
        <div className="bid-conditions">
          <div className="bid-conditions-title">Особые условия</div>
          <ul>{conditions.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}

      {sitePricing ? (
        <>
          <nav className="bid-tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
                className={`bid-tab${tab === t.key ? ' is-active' : ''}`} onClick={() => setTab(t.key)}>
                {t.label}
                {t.count != null && <span className="bid-tab-count">{t.count}</span>}
                {t.warn && <span className="bid-tab-warn" title="Не указана ставка НДС">!</span>}
              </button>
            ))}
          </nav>

          {tab === 'form' && formPanel}
          {(tab === 'material' || tab === 'work') && (
            <BidPositionsTable
              key={tab}
              kind={tab}
              positions={tab === 'material' ? positions.materials : positions.works}
              rates={rates}
              history={history}
              tenderNumbers={tenderNumbers}
              canEdit={editable}
              docs={okFiles.map((f) => f.name)}
              vatExempt={!!vat?.exempt}
              onCommit={commit}
            />
          )}
          {tab === 'kp' && <BidStructureView files={okFiles} rates={rates} />}

          {importOpen && (
            <Suspense fallback={null}>
              <BidImportDialog
                positions={allPositions}
                rates={rates}
                vat={vat}
                onApply={(list) => { commitMany(list); setImportOpen(false) }}
                onClose={() => setImportOpen(false)}
              />
            </Suspense>
          )}
        </>
      ) : (
        <section className="bid-form-section" aria-label="Анкета участника">
          <h4>
            Анкета участника
            {needVat && canEdit && <span className="bid-tab-warn" title="Не указана ставка НДС">!</span>}
          </h4>
          {formPanel}
        </section>
      )}
    </div>
  )
}

function SummaryCell({ label, s }) {
  return (
    <div className="bid-sum-cell">
      <span className="bid-sum-label">{label}: {s.priced} из {s.items}</span>
      <span className="bid-sum-value">{formatAmount(s.total)} ₽</span>
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
  else if (save.error) { text = `Не сохранено: ${save.failed} — ${save.error}`; cls = ' is-error' }
  else if (save.failed > 0) text = 'Сохраняем…'
  else if (save.savedAt) text = `Все цены сохранены · ${save.savedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
  return (
    <div className={`bid-save${cls}`} role="status">
      {text}
      {save.error && <> <button type="button" className="bid-link" onClick={onRetry}>Повторить</button></>}
    </div>
  )
}
