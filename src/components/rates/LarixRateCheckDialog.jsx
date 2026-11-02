import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PaperclipIcon from '../icons/PaperclipIcon'
import { IconAlert } from '../icons/ActionIcons'
import { IconClose } from '../icons/ToolbarIcons'
import { isPdfFile, isSheetFile } from '../../utils/supplierDocRead'
import { DOC_ERROR_TEXT, readBidPriceDoc } from '../../utils/bidImport'
import { DEFAULT_TOLERANCE, VISIBLE_ANALOGS } from '../../utils/kpRateCheck'
import {
  CONTRACT_EXPORT_HEADERS, PRICE_MODES, PRICE_MODE_TEXT, VERDICT_TEXT,
  checkContractLines, contractExportRows, contractSummary, lineCandidates, periodSince, rowPrice, splitPriceParts,
} from '../../utils/larixRateCheck'
import { larixContractUrl } from '../../utils/contractLarix'
import { moscowToday } from '../../utils/kpRegistrySources'
import { fmtMoney, fmtDate, downloadXlsx, todayStamp } from '../../utils/ratesRegistry'
import { loadContractIndex } from '../../services/larixRates'
import { RateFilePicker, ToleranceFieldset, VatFieldset, fmtDev, pct, useFileDrop, useVatChoice } from './RateCheckParts'
import './KpRates.css'

// Больше — не распознаём (страница подвисла бы на разборе).
const PARSE_MAX_BYTES = 30 * 1024 * 1024
// Больше строк за одну проверку не считаем; поиск идёт порциями, окно не замирает.
const LINES_MAX = 3000
const MATCH_CHUNK = 40
// Сколько строк таблицы показывать сразу (строки высокие — на каждой расценки с подробностями).
const LINES_PAGE = 200
const PERIODS = [[0, 'за всё время'], [24, 'за 2 года'], [12, 'за год'], [6, 'за полгода']]

const fmtCount = (n) => Number(n || 0).toLocaleString('ru-RU')
const nextFrame = () => new Promise((resolve) => { setTimeout(resolve) })

// Проверка цен файла по договорным расценкам Larix: файл (заполненный или пустой ВОР, КП, счёт, прайс — Excel, CSV, PDF
// с текстом) распознаётся, как в проверке реестра КП; у каждой строки — договорные цены того же наименования или
// аналогов той же ед. изм. (расчёт — utils/larixRateCheck), их минимум, медиана, максимум и отклонение цены файла.
// Человек видит, из чего сложилась медиана, и может снять неподходящую расценку или включить возможную. Только чтение:
// договорные расценки загружаются из Larix, добавлять в них нечего.
export default function LarixRateCheckDialog({ canOpenContracts = false, onClose }) {
  const [phase, setPhase] = useState('pick') // pick | reading | loading | matching | review
  const [file, setFile] = useState(null)
  const [readError, setReadError] = useState('')
  const [doc, setDoc] = useState(null) // { kind, items, vat, sheetName | pages, cut }
  const [found, setFound] = useState(null) // Map индекс строки → lineCandidates
  const [registrySize, setRegistrySize] = useState(0)
  const [progress, setProgress] = useState(null)
  const [priceMode, setPriceMode] = useState('auto')
  const [months, setMonths] = useState(0)
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE)
  const [filter, setFilter] = useState('all')
  const [sortByDev, setSortByDev] = useState(false)
  const [choices, setChoices] = useState(() => new Map())
  const [shownLines, setShownLines] = useState(LINES_PAGE)
  const runRef = useRef(null)
  const vatChoice = useVatChoice(doc)
  const busy = phase === 'reading' || phase === 'loading' || phase === 'matching'

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => () => { if (runRef.current) runRef.current.cancelled = true }, [])

  // ── Чтение файла и поиск ──────────────────────────────────────────────────────────────────────────
  const readOne = async (f) => {
    if (runRef.current) runRef.current.cancelled = true
    const run = { cancelled: false }
    runRef.current = run
    const fail = (text) => { setReadError(text); setPhase('pick') }
    setFile(f)
    setReadError('')
    setDoc(null)
    setFound(null)
    setChoices(new Map())
    setShownLines(LINES_PAGE)
    if (!isPdfFile(f.name) && !isSheetFile(f.name)) { fail(DOC_ERROR_TEXT.unsupported); return }
    if (f.size > PARSE_MAX_BYTES) { fail(`Файл больше ${PARSE_MAX_BYTES / 1024 / 1024} МБ — такой не распознаём.`); return }
    setPhase('reading')
    let r
    try {
      r = await readBidPriceDoc(new Uint8Array(await f.arrayBuffer()), f.name, { keepBlank: true })
    } catch (e) {
      r = { error: 'broken', message: e.message }
    }
    if (run.cancelled) return
    if (r.error) { fail(`${DOC_ERROR_TEXT[r.error] || DOC_ERROR_TEXT.broken}${r.message ? ` (${r.message})` : ''}`); return }
    const all = splitPriceParts(r.items)
    const items = all.slice(0, LINES_MAX)
    const parsed = { ...r, items, cut: all.length - items.length, blank: items.every((it) => it.price == null && it.sum == null) }
    setDoc(parsed)
    vatChoice.reset(parsed)
    setFilter('all')
    setPhase('loading')
    setProgress(null)
    let index
    try {
      index = await loadContractIndex({ onProgress: (done, total) => { if (!run.cancelled) setProgress({ done, total }) } })
    } catch (e) {
      if (!run.cancelled) fail(`Договорные расценки не прочитаны: ${e.message || e}`)
      return
    }
    if (run.cancelled) return
    if (!index.rowCount) { fail('Договорных расценок пока нет: они появятся после загрузки из Larix.'); return }
    setRegistrySize(index.rowCount)
    setPhase('matching')
    const map = new Map()
    for (let i = 0; i < items.length; i += MATCH_CHUNK) {
      setProgress({ done: i, total: items.length })
      await nextFrame()
      if (run.cancelled) return
      for (let j = i; j < Math.min(i + MATCH_CHUNK, items.length); j++) {
        map.set(j, items[j].delivery ? [] : lineCandidates(items[j], index))
      }
    }
    setFound(map)
    setPhase('review')
  }

  const pickFiles = (list) => {
    const f = [...(list || [])][0]
    if (f) readOne(f)
  }
  const { over, dropProps } = useFileDrop(pickFiles)

  // ── Строки проверки ───────────────────────────────────────────────────────────────────────────────
  const since = useMemo(() => periodSince(months, moscowToday()), [months])
  const lines = useMemo(() => (doc && found
    ? checkContractLines(doc.items, found, { vat: vatChoice.vat, tolerance, priceMode, since, choices })
    : []), [doc, found, vatChoice.vat, tolerance, priceMode, since, choices])
  const summary = useMemo(() => contractSummary(lines), [lines])
  const goods = useMemo(() => lines.filter((l) => l.verdict !== 'delivery'), [lines])
  const shown = useMemo(() => {
    const list = goods.filter((l) => filter === 'all' || l.verdict === filter)
    return sortByDev ? [...list].sort((a, b) => Math.abs(b.dev ?? -1) - Math.abs(a.dev ?? -1)) : list
  }, [goods, filter, sortByDev])

  const toggle = useCallback((i, rowId, on) => setChoices((prev) => {
    const next = new Map(prev)
    next.set(`${i}|${rowId}`, on)
    return next
  }), [])

  const exportXlsx = () => {
    const base = (file?.name || 'файл').replace(/\.[^.]+$/, '')
    downloadXlsx(CONTRACT_EXPORT_HEADERS, contractExportRows(lines), 'Проверка по договорам', `Проверка по договорам — ${base} ${todayStamp()}.xlsx`,
      [5, 50, 9, 9, 14, 18, 9, 11, 12, 12, 12, 12, 14, 14, 18, 44, 26, 26, 18, 12, 14])
  }

  // ── Отрисовка ─────────────────────────────────────────────────────────────────────────────────────
  const inReview = phase === 'review' && !!doc && !!found
  const fileDiff = summary.fileSum - summary.medianSum
  const fileDiffPct = summary.medianSum > 0 ? Math.round((fileDiff / summary.medianSum) * 1000) / 10 : null
  return (
    <div className="kpr-backdrop" role="presentation" {...dropProps} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className={`kpr-modal${inReview ? ' is-wide' : ''}${over ? ' is-over' : ''}`} role="dialog" aria-modal="true" aria-labelledby="kpr-larix-title">
        <div className="kpr-modal-head">
          <h3 id="kpr-larix-title">Проверка цен по договорным расценкам</h3>
          <button type="button" className="kpr-icon-btn" onClick={onClose} aria-label="Закрыть"><IconClose size={16} /></button>
        </div>
        <div className="kpr-modal-body">
          {!inReview && (
            <>
              <p className="kpr-muted">
                Загрузите КП, счёт, прайс или ВОР (Excel, CSV или PDF с текстом): у каждой строки найдутся цены заключённых
                договоров и ДС из Larix — то же наименование или аналог с той же ед. изм. Покажем, дороже или дешевле цена файла,
                чем в договорах. В незаполненном ВОРе цен нет — он покажет договорные цены по своим позициям.
              </p>
              <RateFilePicker disabled={busy} over={over} onFiles={pickFiles} />
              {phase === 'reading' && <p className="kpr-progress" role="status">Распознаём «{file?.name}»…</p>}
              {phase === 'loading' && (
                <p className="kpr-progress" role="status">
                  Загружаем договорные расценки{progress?.total ? `: ${fmtCount(progress.done)} из ${fmtCount(progress.total)}` : ''}…
                </p>
              )}
              {phase === 'matching' && progress && (
                <p className="kpr-progress" role="status">Ищем в договорах: {fmtCount(progress.done)} из {fmtCount(progress.total)} строк…</p>
              )}
              {readError && <p className="kpr-error" role="alert"><IconAlert size={14} /> {file ? `«${file.name}»: ` : ''}{readError}</p>}
            </>
          )}

          {inReview && (
            <>
              <div className="kpr-summary">
                <span className="kpr-file-name"><PaperclipIcon size={14} /> {file.name}</span>
                <span className="kpr-muted">
                  {doc.kind === 'pdf' ? `PDF, страниц: ${doc.pages}` : `лист «${doc.sheetName}»`}
                  {' · '}строк: <b className="kpr-num">{fmtCount(summary.total)}</b>, с договорными ценами: <b className="kpr-num">{fmtCount(summary.withStats)}</b>
                  {' · '}договорных расценок: <span className="kpr-num">{fmtCount(registrySize)}</span>
                  {doc.cut > 0 ? ` (проверены первые ${fmtCount(LINES_MAX)}, ещё ${fmtCount(doc.cut)} — следующим файлом)` : ''}
                </span>
                <button type="button" className="kpr-link-btn" onClick={() => { setPhase('pick'); setDoc(null); setFound(null) }}>другой файл</button>
              </div>
              {doc.blank && <p className="kpr-note" role="status">В файле нет цен — показаны договорные цены по его позициям.</p>}
              {summary.medianSum > 0 && summary.fileSum > 0 && (
                <p className="kpr-total" role="status">
                  По строкам с договорными ценами: в файле <b className="kpr-num">{fmtMoney(summary.fileSum)} ₽</b>, по медиане договоров{' '}
                  <b className="kpr-num">{fmtMoney(summary.medianSum)} ₽</b>
                  {' — '}<b className={`kpr-num ${fileDiff > 0 ? 'kpr-more' : 'kpr-less'}`}>{fileDiff > 0 ? '+' : fileDiff < 0 ? '−' : ''}{fmtMoney(Math.abs(fileDiff))} ₽ ({fmtDev(fileDiffPct)})</b>
                </p>
              )}

              <div className="kpr-settings is-row">
                <VatFieldset doc={doc} choice={vatChoice} />
                <fieldset>
                  <legend>Цену файла сравнивать с</legend>
                  <label title="Строки листов «Материалы» / «Работы» и колонок цены материалов и работ — всегда со своей ценой">
                    <select value={priceMode} onChange={(e) => setPriceMode(e.target.value)} aria-label="Цену файла сравнивать с">
                      {PRICE_MODES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                    </select>
                  </label>
                </fieldset>
                <fieldset>
                  <legend>Договоры и ДС</legend>
                  <label>
                    <select value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label="Период договоров">
                      {PERIODS.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
                    </select>
                  </label>
                </fieldset>
                <ToleranceFieldset legend="Допуск от медианы договоров" tolerance={tolerance} onChange={setTolerance} />
              </div>

              <div className="kpr-filters-row">
                <div className="kpr-filters" role="group" aria-label="Показать строки">
                  {[['all', 'Все', summary.total], ['high', 'Дороже договоров', summary.high], ['low', 'Дешевле договоров', summary.low],
                    ['ok', 'В рынке', summary.ok], ['none', 'Нет аналогов', summary.none], ['noprice', 'Нет цены', summary.noprice]]
                    .filter(([k, , n]) => k === 'all' || n > 0)
                    .map(([k, label, n]) => (
                      <button key={k} type="button" className={`kpr-filter${filter === k ? ' active' : ''}`} aria-pressed={filter === k}
                        onClick={() => { setFilter(k); setShownLines(LINES_PAGE) }}>
                        {label}<span className="kpr-num">{n}</span>
                      </button>
                    ))}
                </div>
                <label className="kpr-foot-note">
                  <input type="checkbox" checked={sortByDev} onChange={(e) => setSortByDev(e.target.checked)} /> сначала большие отклонения
                </label>
              </div>

              <div className="kpr-table-wrap">
                <table className="kpr-table">
                  <colgroup>
                    <col className="kpr-c-line" /><col className="kpr-c-price" /><col className="kpr-c-reg" /><col className="kpr-c-dev" /><col />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Строка файла</th>
                      <th className="kpr-money">Цена с НДС, ₽</th>
                      <th>Договоры: мин. · медиана · макс.</th>
                      <th>Отклонение</th>
                      <th>Договорные расценки: снимите неподходящие, отметьте подходящие</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.slice(0, shownLines).map((l) => (
                      <CheckLine key={l.i} line={l} canOpenContracts={canOpenContracts} onToggle={toggle} />
                    ))}
                    {!shown.length && <tr><td colSpan={5} className="kpr-muted">Строк нет</td></tr>}
                  </tbody>
                </table>
                {shown.length > shownLines && (
                  <button type="button" className="kpr-btn kpr-more-lines" onClick={() => setShownLines((n) => n + LINES_PAGE)}>
                    Показать ещё {Math.min(LINES_PAGE, shown.length - shownLines)} из {fmtCount(shown.length - shownLines)}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <div className="kpr-modal-foot">
          {inReview && <button type="button" className="kpr-btn" onClick={exportXlsx} disabled={!goods.length}>Выгрузить проверку в Excel</button>}
          <button type="button" className="kpr-btn" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}

// Строка проверки: строка файла, её цена с НДС, цены договоров, отклонение и расценки, из которых всё сложилось.
const CheckLine = memo(function CheckLine({ line, canOpenContracts, onToggle }) {
  const [moreAnalogs, setMoreAnalogs] = useState(false)
  const [morePossible, setMorePossible] = useState(false)
  const { i, item, mode, price, stats, dev, verdict, analogs, possible, otherUnit } = line
  const shownAnalogs = moreAnalogs ? analogs : analogs.slice(0, VISIBLE_ANALOGS)
  // Включённая человеком видна всегда; нет ни одного аналога — возможные видны сразу, иначе их не заметить.
  const shownPossible = morePossible ? possible : possible.filter((p, n) => p.on || (!analogs.length && n < VISIBLE_ANALOGS))
  const point = (p) => <ContractPoint key={p.row.id} p={p} i={i} mode={mode} unit={item.unit} canOpenContracts={canOpenContracts} onToggle={onToggle} />
  return (
    <tr>
      <td>
        <div className="kpr-line-name">{item.name}</div>
        <div className="kpr-meta">
          {item.kindHint && <span>{item.kindHint === 'work' ? 'работа' : 'материал'}</span>}
          {item.code && <span>арт. {item.code}</span>}
          {item.qty != null && <span className="kpr-num">{String(item.qty).replace('.', ',')} {item.unit || ''}</span>}
          {item.qty == null && item.unit && <span>{item.unit}</span>}
          {item.source && <span>{item.source}</span>}
          <span>сравнивается: {PRICE_MODE_TEXT[mode]}</span>
        </div>
      </td>
      <td className="kpr-money">{price != null ? fmtMoney(price) : '—'}</td>
      <td>
        {stats ? (
          <div className="kpr-stats">
            <span>{fmtMoney(stats.min)} · <b>{fmtMoney(stats.median)}</b> · {fmtMoney(stats.max)}</span>
            <span className="kpr-muted">цен: {stats.n}, подрядчиков: {stats.contractors}{stats.exact ? `, то же наименование: ${stats.exact}` : ''}</span>
          </div>
        ) : (
          <span className="kpr-muted">
            {possible.length ? `только возможные: ${possible.length}` : otherUnit.length ? 'только в другой ед. изм.' : 'аналогов нет'}
          </span>
        )}
      </td>
      <td>
        <span className={`kpr-verdict is-${verdict}`}>{VERDICT_TEXT[verdict]}</span>
        {dev != null && <div className="kpr-num kpr-muted">{fmtDev(dev)} к медиане</div>}
      </td>
      <td>
        {analogs.length + possible.length + otherUnit.length === 0 ? <span className="kpr-muted">—</span> : (
          <ul className="kpr-analogs">
            {shownAnalogs.map(point)}
            {analogs.length > VISIBLE_ANALOGS && (
              <li><button type="button" className="kpr-link-btn" onClick={() => setMoreAnalogs((m) => !m)}>
                {moreAnalogs ? 'свернуть' : `ещё ${analogs.length - VISIBLE_ANALOGS}`}
              </button></li>
            )}
            {shownPossible.map(point)}
            {possible.length > shownPossible.length && (
              <li><button type="button" className="kpr-link-btn" onClick={() => setMorePossible(true)}>
                {shownPossible.length ? `ещё возможные: ${possible.length - shownPossible.length}` : `возможные: ${possible.length}`}
              </button></li>
            )}
            {morePossible && <li><button type="button" className="kpr-link-btn" onClick={() => setMorePossible(false)}>скрыть возможные</button></li>}
            {!analogs.length && !possible.length && otherUnit.map((x) => <OtherUnitRow key={x.row.id} x={x} />)}
          </ul>
        )}
      </td>
    </tr>
  )
})

const pointLabel = (p) => {
  if (p.exact) return 'то же наименование'
  if (p.code) return `артикул совпал · ${pct(p.score)}`
  if (p.apart) return 'другой размер или марка'
  if (p.weak) return `уточнить · ${pct(p.score)}`
  return `похоже на ${pct(p.score)}`
}

function ContractLink({ row, canOpenContracts }) {
  const label = `${row.object_type && row.object_type !== 'Договор' ? row.object_type : 'Договор'}${row.contract_number ? ` № ${row.contract_number}` : ''}`
  const url = canOpenContracts && row.osp_contract_id ? `/contracts/${row.osp_contract_id}` : larixContractUrl(row.contract_id)
  return url
    ? <a href={url} target="_blank" rel="noopener noreferrer">{label}</a>
    : <span>{label}</span>
}

// Расценка договора: галочка «учитывать», цена в единицах строки файла и откуда она.
function ContractPoint({ p, i, mode, unit, canOpenContracts, onToggle }) {
  const r = p.row
  const both = r.price_material != null && r.price_work != null
  const shownUnit = p.factor === 1 ? r.unit : unit
  return (
    <li className={`kpr-analog has-check${p.on ? '' : p.auto ? ' is-off is-removed' : ' is-off'}`}>
      <input type="checkbox" checked={p.on} onChange={(e) => onToggle(i, r.id, e.target.checked)} aria-label={`Учитывать: ${r.item_name}`} />
      <span className="kpr-analog-name">{r.item_name}</span>
      <span className="kpr-analog-price">{fmtMoney(p.price)} ₽{shownUnit ? ` / ${shownUnit}` : ''}</span>
      <span className="kpr-analog-meta">
        <span className="kpr-score">{pointLabel(p)}</span>
        {both && <span>материалы {fmtMoney(r.price_material)} + работы {fmtMoney(r.price_work)}{mode === 'position' ? ' — сравнивается цена материалов' : ''}</span>}
        {p.factor !== 1 && <span>в договоре {fmtMoney(rowPrice(r, mode))} ₽ / {r.unit}</span>}
        {r.contractor_name && <span>{r.contractor_name}</span>}
        {r.project_name && <span>{r.project_name}</span>}
        <ContractLink row={r} canOpenContracts={canOpenContracts} />
        {r.contract_date && <span>{fmtDate(r.contract_date)}</span>}
        {p.older > 0 && <span>в прежних документах: {p.older}</span>}
        {r.comment && <span>{r.comment}</span>}
      </span>
    </li>
  )
}

function OtherUnitRow({ x }) {
  const r = x.row
  return (
    <li className="kpr-analog is-other-unit">
      <span className="kpr-analog-name">{r.item_name}</span>
      <span className="kpr-analog-price">
        {r.price_material != null && `${fmtMoney(r.price_material)} ₽`}
        {r.price_material != null && r.price_work != null && ' + '}
        {r.price_work != null && `${fmtMoney(r.price_work)} ₽`}
        {r.unit ? ` / ${r.unit}` : ''}
      </span>
      <span className="kpr-analog-meta">
        <span className="kpr-score">другая ед. изм.</span>
        {r.contractor_name && <span>{r.contractor_name}</span>}
        {r.contract_date && <span>{fmtDate(r.contract_date)}</span>}
      </span>
    </li>
  )
}
