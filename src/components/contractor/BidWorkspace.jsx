import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import {
  loadTenderFiles, downloadFileBytes, loadMyRates, loadMyRateHistory, saveRates, loadFormFields, loadMyForm, VOR_CATEGORIES,
} from '../../services/contractorBids'
import { vatFromAnswers, vatField, vatIncluded, vatLabel } from '../../utils/bidForm'
import { readBidFileBytes, mergeBidFiles, rateKey, BID_KIND_LABEL } from '../../utils/bidVor'
import { isWorkbookFileName } from '../../utils/vorFiles'
import { formatAmount } from '../../utils/money'
import BidPositionsTable from './BidPositionsTable'
import BidStructureView from './BidStructureView'
import BidFormPanel from './BidFormPanel'
import './BidWorkspace.css'

const BidImportDialog = lazy(() => import('./BidImportDialog'))

// Расценка ВОР подрядчиком в кабинете (миграция 20261102): позиции — из файлов ВОР тендера («ВОРы и РД»,
// листы «Материалы», «Работы», «КП»), цена — одна на уникальную позицию тендера, пишется сама (через
// SAVE_DELAY_MS после ввода, порцией). Отдел видит цены сразу — отправлять ничего не нужно (решение пользователя).
//
// canEdit — тендер открыт и у организации есть доступ (участник или заявка не отклонена): иначе только просмотр.

const SAVE_DELAY_MS = 600

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
}

export default function BidWorkspace({ tender, canEdit, counterpartyName, tenderNumbers, onSummary }) {
  const tenderId = tender.id
  const [files, setFiles] = useState(null) // null — загрузка списка
  const [filesError, setFilesError] = useState('')
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

  // ── Файлы ВОР ──────────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setFiles(null)
    setParsed({})
    setFilesError('')
    loadTenderFiles(tenderId)
      .then((all) => {
        if (cancelled) return
        const vor = all.filter((f) => VOR_CATEGORIES.includes(f.doc_category) && isWorkbookFileName(f.file_name))
        setFiles(vor)
      })
      .catch((e) => { if (!cancelled) { setFiles([]); setFilesError(e.message || String(e)) } })
    return () => { cancelled = true }
  }, [tenderId])

  useEffect(() => {
    if (!files?.length) return undefined
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
  }, [files])

  const okFiles = useMemo(() => (files || [])
    .filter((f) => parsed[f.id]?.status === 'ok')
    .map((f) => ({ id: f.id, name: fileTitle(f.file_name), parsed: parsed[f.id].result })), [files, parsed])
  const positions = useMemo(() => mergeBidFiles(okFiles), [okFiles])
  const allPositions = useMemo(() => [...positions.materials, ...positions.works], [positions])
  const parsing = (files || []).some((f) => !parsed[f.id] || parsed[f.id].status === 'loading')

  useEffect(() => {
    let cancelled = false
    setFormFields(null)
    setFormError('')
    Promise.all([loadFormFields(), loadMyForm(tenderId)])
      .then(([list, { form, previous }]) => {
        if (cancelled) return
        setFormFields(list || [])
        setAnswers(Object.fromEntries(Object.entries(form?.answers || {}).map(([k, v]) => [k, v?.value ?? ''])))
        setPreviousForm(!form && previous ? previous : null)
      })
      .catch((e) => { if (!cancelled) { setFormFields([]); setFormError(e.message || String(e)) } })
    return () => { cancelled = true }
  }, [tenderId])
  const vat = useMemo(() => vatFromAnswers(formFields, answers), [formFields, answers])
  const needVat = !!vatField(formFields) && !vat

  // ── Цены ───────────────────────────────────────────────────────────────────────────────────────────
  const loadRates = useCallback(async () => {
    setRatesState('loading')
    try {
      const rows = await loadMyRates(tenderId)
      setRates(new Map(rows.map((r) => [rateKey(r), { price: r.price == null ? null : Number(r.price), note: r.note || '', source: r.source, updated_at: r.updated_at }])))
      setRatesState('ok')
    } catch (e) {
      console.error('Цены подрядчика:', e)
      setRatesState('error')
    }
  }, [tenderId])
  useEffect(() => { loadRates() }, [loadRates])

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
    if (parsing || !okFiles.length) return []
    const keys = new Set(allPositions.map((p) => p.key))
    return [...rates.entries()].filter(([k, r]) => !keys.has(k) && r.price != null)
  }, [rates, allPositions, parsing, okFiles.length])

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

  const exportExcel = async () => {
    const { downloadBidWorkbook } = await import('../../utils/bidExport')
    downloadBidWorkbook({ tender, counterpartyName, positions, rates, files: okFiles, form: { fields: formFields || [], answers } })
  }

  // Особые условия «Главного листа» всех файлов ВОР — без повторов.
  const conditions = useMemo(() => [...new Set(okFiles.flatMap((f) => f.parsed.conditions || []))], [okFiles])

  // ── Отрисовка ──────────────────────────────────────────────────────────────────────────────────────
  if (files === null) return <div className="bid-state">Загрузка файлов ВОР…</div>

  const fileProblems = (files || []).filter((f) => parsed[f.id]?.status === 'error')
  const tabs = [
    { key: 'form', label: 'Анкета', warn: needVat && canEdit },
    { key: 'material', label: BID_KIND_LABEL.material, count: positions.materials.length },
    { key: 'work', label: BID_KIND_LABEL.work, count: positions.works.length },
    { key: 'kp', label: 'Структура КП' },
  ]

  return (
    <div className="bid-ws">
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
          <button type="button" className="cab-btn" onClick={exportExcel} disabled={!allPositions.length}>Скачать Excel</button>
        </div>
      </div>

      <SaveLine save={save} canEdit={canEdit} ratesState={ratesState} onRetry={() => flushRef.current()} onReload={loadRates} />

      {filesError && <div className="bid-note is-warn">Файлы тендера не загрузились: {filesError}</div>}
      {files.length === 0 && !filesError && (
        <div className="bid-note">
          Файлы ВОР ещё не опубликованы — расценка появится, когда отдел загрузит ВОР в Excel.
        </div>
      )}
      {parsing && files.length > 0 && <div className="bid-note">Читаем файлы ВОР…</div>}
      {fileProblems.length > 0 && (
        <div className="bid-note is-warn">
          Не удалось разобрать: {fileProblems.map((f) => `«${fileTitle(f.file_name)}» — ${PARSE_ERROR[parsed[f.id].error] || 'файл не скачался'}`).join('; ')}.
          {' '}Сообщите ответственному по тендеру.
        </div>
      )}
      {orphanRates.length > 0 && (
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

      {tab === 'form' && (
        <BidFormPanel
          tenderId={tenderId}
          canEdit={canEdit}
          fields={formFields}
          answers={answers}
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

function SaveLine({ save, canEdit, ratesState, onRetry, onReload }) {
  if (ratesState === 'error') {
    return (
      <div className="bid-save is-error">
        Ваши цены не загрузились. <button type="button" className="bid-link" onClick={onReload}>Повторить</button>
      </div>
    )
  }
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
