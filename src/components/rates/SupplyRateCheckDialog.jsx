import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PaperclipIcon from '../icons/PaperclipIcon'
import { IconAlert } from '../icons/ActionIcons'
import { IconClose, IconSearch } from '../icons/ToolbarIcons'
import { isImageFile, isPdfFile, isSheetFile } from '../../utils/supplierDocRead'
import { DOC_ERROR_TEXT, readBidPriceDoc } from '../../utils/bidImport'
import { searchGroups } from '../../utils/supplyDocMatch'
import { DEFAULT_TOLERANCE, VISIBLE_ANALOGS } from '../../utils/kpRateCheck'
import {
  SUPPLY_CHECK_EXPORT_HEADERS, VERDICT_TEXT, checkSupplyLines, lineCandidates, materialLines, periodStart, supplyCheckExportRows,
  supplyCheckSummary,
} from '../../utils/supplyRegistryCheck'
import { isWebLink, moscowToday } from '../../utils/kpRegistrySources'
import { fmtMoney, fmtMoscowDate, downloadXlsx, todayStamp } from '../../utils/ratesRegistry'
import { loadSupplyCheckIndex } from '../../services/supplyRegistryCheck'
import { GRADES, GRADE_INFO, moscowDay } from '../../utils/supplyPriceSearch'
import { isFreshPriceDate } from '../../utils/supplyRateHelpers'
import { RateFilePicker, ToleranceFieldset, VatFieldset, fmtDev, pct, useFileDrop, useVatChoice } from './RateCheckParts'
import './KpRates.css'

// Больше — не распознаём (страница подвисла бы на разборе).
const PARSE_MAX_BYTES = 30 * 1024 * 1024
// Больше строк за одну проверку не ищем: на всём реестре — около 20 мс на строку, поиск идёт порциями по времени, окно не замирает.
const LINES_MAX = 1000
const SLICE_MS = 40
// Сколько строк таблицы показывать сразу (строки высокие — у каждой позиции реестра с ценами).
const LINES_PAGE = 200
const PERIODS = [[0, 'за всё время'], [24, 'за 2 года'], [12, 'за год'], [6, 'за полгода']]
// Поиск позиции по реестру: сколько показать и через сколько после ввода искать (на всём реестре — десятки мс).
const FIND_LIMIT = 8
const FIND_DELAY_MS = 250
// Сколько цен позиции показывать в раскрытом списке.
const POINTS_LIMIT = 30

const fmtCount = (n) => Number(n || 0).toLocaleString('ru-RU')
const nextFrame = () => new Promise((resolve) => { setTimeout(resolve) })

// Проверка цен файла по реестру СУ-10: файл (счёт, КП, прайс, заполненный или пустой ВОР — Excel, CSV, PDF с текстом) распознаётся, как
// в проверке реестра КП; у каждой строки — позиции реестра, найденные так же, как в тендерах на материалы строке счёта ищутся позиции
// ВОР (utils/supplyRegistryCheck), их цены за единицу строки, минимум, медиана, максимум и отклонение цены файла. Человек видит, из
// каких расценок сложилась медиана, может снять неподходящую, включить возможную или найти позицию поиском по реестру. Только чтение:
// расценки в реестр добавляет «Загрузить из Excel». hasDetails — в базе есть подробности загруженных строк (поставщик, ссылка на счёт).
export default function SupplyRateCheckDialog({ hasDetails = false, onClose }) {
  const [phase, setPhase] = useState('pick') // pick | reading | loading | indexing | matching | review
  const [file, setFile] = useState(null)
  const [readError, setReadError] = useState('')
  const [doc, setDoc] = useState(null) // { kind, items, vat, sheetName | pages, cut, works, blank }
  const [found, setFound] = useState(null) // Map индекс строки → lineCandidates
  const [index, setIndex] = useState(null)
  const [progress, setProgress] = useState(null)
  const [months, setMonths] = useState(0)
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE)
  const [filter, setFilter] = useState('all')
  const [sortByDev, setSortByDev] = useState(false)
  const [choices, setChoices] = useState(() => new Map())
  const [picked, setPicked] = useState(() => new Map())
  const [shownLines, setShownLines] = useState(LINES_PAGE)
  const runRef = useRef(null)
  const vatChoice = useVatChoice(doc)
  const busy = phase === 'reading' || phase === 'loading' || phase === 'indexing' || phase === 'matching'

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => () => { if (runRef.current) runRef.current.cancelled = true }, [])

  // ── Чтение файла и поиск позиций ──────────────────────────────────────────────────────────────────
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
    setPicked(new Map())
    setShownLines(LINES_PAGE)
    if (!isPdfFile(f.name) && !isSheetFile(f.name) && !isImageFile(f.name)) { fail(DOC_ERROR_TEXT.unsupported); return }
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
    const { items: all, works } = materialLines(r.items)
    if (!all.length) { fail(works ? 'В файле только работы — в реестре СУ-10 цены материалов.' : 'В файле не нашлось строк с наименованием.'); return }
    const items = all.slice(0, LINES_MAX)
    const parsed = { ...r, items, works, cut: all.length - items.length, blank: items.every((it) => it.price == null && it.sum == null) }
    setDoc(parsed)
    vatChoice.reset(parsed)
    setFilter('all')
    setPhase('loading')
    setProgress(null)
    let ix
    try {
      ix = await loadSupplyCheckIndex({
        details: hasDetails,
        onProgress: (done, total) => { if (!run.cancelled) setProgress({ done, total }) },
        onIndexing: () => { if (!run.cancelled) setPhase('indexing') },
      })
    } catch (e) {
      if (!run.cancelled) fail(`Реестр СУ-10 не прочитан: ${e.message || e}`)
      return
    }
    if (run.cancelled) return
    if (!ix.rowCount) { fail('В реестре СУ-10 пока нет расценок с ценой.'); return }
    setIndex(ix)
    setPhase('matching')
    const map = new Map()
    let i = 0
    while (i < items.length) {
      setProgress({ done: i, total: items.length })
      await nextFrame()
      if (run.cancelled) return
      const until = performance.now() + SLICE_MS
      do {
        map.set(i, lineCandidates(items[i], ix))
        i += 1
      } while (i < items.length && performance.now() < until)
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
  const since = useMemo(() => periodStart(months, moscowToday()), [months])
  const lines = useMemo(() => (doc && found
    ? checkSupplyLines(doc.items, found, { vat: vatChoice.vat, tolerance, since, choices, picked })
    : []), [doc, found, vatChoice.vat, tolerance, since, choices, picked])
  const summary = useMemo(() => supplyCheckSummary(lines), [lines])
  const goods = useMemo(() => lines.filter((l) => l.verdict !== 'delivery'), [lines])
  const shown = useMemo(() => {
    const list = goods.filter((l) => filter === 'all' || l.verdict === filter)
    return sortByDev ? [...list].sort((a, b) => Math.abs(b.dev ?? -1) - Math.abs(a.dev ?? -1)) : list
  }, [goods, filter, sortByDev])

  const toggle = useCallback((i, key, on) => setChoices((prev) => {
    const next = new Map(prev)
    next.set(`${i}|${key}`, on)
    return next
  }), [])
  const pick = useCallback((i, group) => {
    setPicked((prev) => {
      const list = prev.get(i) || []
      if (list.some((g) => g.key === group.key)) return prev
      const next = new Map(prev)
      next.set(i, [...list, group])
      return next
    })
    // Позиция уже была среди кандидатов (возможная или снятая) — включить её.
    toggle(i, group.key, true)
  }, [toggle])

  const exportXlsx = () => {
    const base = (file?.name || 'файл').replace(/\.[^.]+$/, '')
    downloadXlsx(SUPPLY_CHECK_EXPORT_HEADERS, supplyCheckExportRows(lines), 'Проверка по СУ-10', `Проверка по реестру СУ-10 — ${base} ${todayStamp()}.xlsx`,
      [5, 50, 9, 9, 14, 10, 10, 12, 12, 12, 14, 14, 14, 18, 44, 10, 12, 14, 14, 24, 30, 12])
  }

  // ── Отрисовка ─────────────────────────────────────────────────────────────────────────────────────
  const inReview = phase === 'review' && !!doc && !!found
  const fileDiff = summary.fileSum - summary.medianSum
  const fileDiffPct = summary.medianSum > 0 ? Math.round((fileDiff / summary.medianSum) * 1000) / 10 : null
  return (
    <div className="kpr-backdrop" role="presentation" {...dropProps} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className={`kpr-modal${inReview ? ' is-wide' : ''}${over ? ' is-over' : ''}`} role="dialog" aria-modal="true" aria-labelledby="kpr-su10-title">
        <div className="kpr-modal-head">
          <h3 id="kpr-su10-title">Проверка цен по реестру СУ-10</h3>
          <button type="button" className="kpr-icon-btn" onClick={onClose} aria-label="Закрыть"><IconClose size={16} /></button>
        </div>
        <div className="kpr-modal-body">
          {!inReview && (
            <>
              <p className="kpr-muted">
                Загрузите счёт, КП, прайс или ВОР (Excel, CSV или PDF с текстом): у каждой строки найдутся расценки снабжения СУ-10 —
                позиции ищутся так же, как в тендерах на материалы строкам счёта (то же наименование, похожее, артикул, упаковка
                и бухта пересчитываются на единицу). Покажем, дороже или дешевле цена файла, чем в реестре. В незаполненном ВОРе цен
                нет — он покажет цены реестра по своим позициям.
              </p>
              <RateFilePicker disabled={busy} over={over} onFiles={pickFiles} />
              {phase === 'reading' && <p className="kpr-progress" role="status">Распознаём «{file?.name}»…</p>}
              {phase === 'loading' && (
                <p className="kpr-progress" role="status">
                  Загружаем реестр СУ-10{progress?.total ? `: ${fmtCount(progress.done)} из ${fmtCount(progress.total)}` : ''}…
                </p>
              )}
              {phase === 'indexing' && <p className="kpr-progress" role="status">Готовим поиск по реестру…</p>}
              {phase === 'matching' && progress && (
                <p className="kpr-progress" role="status">Ищем позиции в реестре: {fmtCount(progress.done)} из {fmtCount(progress.total)} строк…</p>
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
                  {' · '}строк: <b className="kpr-num">{fmtCount(summary.total)}</b>, с ценами реестра: <b className="kpr-num">{fmtCount(summary.withStats)}</b>
                  {' · '}расценок в реестре: <span className="kpr-num">{fmtCount(index?.rowCount)}</span>
                  {doc.cut > 0 ? ` (проверены первые ${fmtCount(LINES_MAX)}, ещё ${fmtCount(doc.cut)} — следующим файлом)` : ''}
                  {doc.works > 0 ? ` · строк работ не проверяли: ${fmtCount(doc.works)}` : ''}
                </span>
                <button type="button" className="kpr-link-btn" onClick={() => { setPhase('pick'); setDoc(null); setFound(null) }}>другой файл</button>
              </div>
              {doc.blank && <p className="kpr-note" role="status">В файле нет цен — показаны цены реестра СУ-10 по его позициям.</p>}
              {summary.medianSum > 0 && summary.fileSum > 0 && (
                <p className="kpr-total" role="status">
                  По строкам с ценами реестра: в файле <b className="kpr-num">{fmtMoney(summary.fileSum)} ₽</b>, по медиане реестра{' '}
                  <b className="kpr-num">{fmtMoney(summary.medianSum)} ₽</b>
                  {' — '}<b className={`kpr-num ${fileDiff > 0 ? 'kpr-more' : 'kpr-less'}`}>{fileDiff > 0 ? '+' : fileDiff < 0 ? '−' : ''}{fmtMoney(Math.abs(fileDiff))} ₽ ({fmtDev(fileDiffPct)})</b>
                </p>
              )}

              <div className="kpr-settings is-row">
                <VatFieldset doc={doc} choice={vatChoice} />
                <fieldset>
                  <legend>Расценки реестра</legend>
                  <label>
                    <select value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label="Период расценок">
                      {PERIODS.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
                    </select>
                  </label>
                </fieldset>
                <ToleranceFieldset legend="Допуск от медианы реестра" tolerance={tolerance} onChange={setTolerance} />
              </div>

              <div className="kpr-filters-row">
                <div className="kpr-filters" role="group" aria-label="Показать строки">
                  {[['all', 'Все', summary.total], ['high', 'Дороже реестра', summary.high], ['low', 'Дешевле реестра', summary.low],
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
                      <th>Реестр: мин. · медиана · макс.</th>
                      <th>Отклонение</th>
                      <th>Позиции реестра: снимите неподходящие, отметьте подходящие</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.slice(0, shownLines).map((l) => (
                      <CheckLine key={l.i} line={l} index={index} onToggle={toggle} onPick={pick} />
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

// Строка проверки: строка файла, её цена с НДС, цены реестра, отклонение и позиции реестра, из которых всё сложилось.
const CheckLine = memo(function CheckLine({ line, index, onToggle, onPick }) {
  const [moreChosen, setMoreChosen] = useState(false)
  const [morePossible, setMorePossible] = useState(false)
  const [finding, setFinding] = useState(false)
  const { i, item, price, entries, possibleCount, otherUnit, older, stats, dev, verdict } = line
  const chosen = entries.filter((e) => e.auto || e.manual)
  const possible = entries.filter((e) => !e.auto && !e.manual)
  const shownChosen = moreChosen ? chosen : chosen.slice(0, VISIBLE_ANALOGS)
  // Включённая человеком видна всегда; своих нет ни одной — возможные видны сразу, иначе их не заметить.
  const shownPossible = morePossible ? possible : possible.filter((e, n) => e.on || (!chosen.length && n < VISIBLE_ANALOGS))
  const entry = (e) => <RegistryEntry key={e.key} e={e} i={i} item={item} onToggle={onToggle} />
  // Возможные — по ступеням похожести, с заголовком ступени (26.11.2026: «непонятно визуальное разделение»).
  const possibleByGrade = GRADES.map((g) => [g, shownPossible.filter((e) => (e.grade || 'far') === g)]).filter(([, list]) => list.length)
  return (
    <tr>
      <td>
        <div className="kpr-line-name">{item.name}</div>
        <div className="kpr-meta">
          {item.code && <span>арт. {item.code}</span>}
          {item.qty != null && <span className="kpr-num">{String(item.qty).replace('.', ',')} {item.unit || ''}</span>}
          {item.qty == null && item.unit && <span>{item.unit}</span>}
          {item.source && <span>{item.source}</span>}
        </div>
      </td>
      <td className="kpr-money">{price != null ? fmtMoney(price) : '—'}</td>
      <td>
        {stats ? (
          <div className="kpr-stats">
            <span>{fmtMoney(stats.min)} · <b>{fmtMoney(stats.median)}</b> · {fmtMoney(stats.max)}</span>
            <span className="kpr-muted">
              цен: {stats.n}{stats.names > 1 ? `, позиций: ${stats.names}` : ''}{stats.exact ? `, то же наименование: ${stats.exact}` : ''}
            </span>
            <span className="kpr-muted">последняя {fmtMoscowDate(stats.newest.row.rate_date)}: {fmtMoney(stats.newest.price)}</span>
            {stats.models && <span className="kpr-muted" title="В строке нет модели или марки: медиана — по разным моделям из реестра">по уточнённым моделям</span>}
          </div>
        ) : (
          <span className="kpr-muted">
            {possibleCount ? `только возможные: ${possibleCount}` : otherUnit.length ? 'только в другой ед. изм.' : older ? 'только старше периода' : 'аналогов нет'}
          </span>
        )}
      </td>
      <td>
        <span className={`kpr-verdict is-${verdict}`}>{VERDICT_TEXT[verdict]}</span>
        {dev != null && <div className="kpr-num kpr-muted">{fmtDev(dev)} к медиане</div>}
      </td>
      <td>
        <ul className="kpr-analogs">
          {shownChosen.map(entry)}
          {chosen.length > VISIBLE_ANALOGS && (
            <li><button type="button" className="kpr-link-btn" onClick={() => setMoreChosen((m) => !m)}>
              {moreChosen ? 'свернуть' : `ещё ${chosen.length - VISIBLE_ANALOGS}`}
            </button></li>
          )}
          {possibleByGrade.map(([g, list]) => [
            <li key={`h:${g}`} className={`kpr-grade-head is-${g}`}>возможные · {GRADE_INFO[g].title.toLowerCase()}: {list.length}</li>,
            ...list.map(entry),
          ])}
          {possible.length > shownPossible.length && (
            <li><button type="button" className="kpr-link-btn" onClick={() => setMorePossible(true)}>
              {shownPossible.length ? `ещё возможные: ${possible.length - shownPossible.length}` : `возможные: ${possible.length}`}
            </button></li>
          )}
          {morePossible && <li><button type="button" className="kpr-link-btn" onClick={() => setMorePossible(false)}>скрыть возможные</button></li>}
          {!entries.length && otherUnit.map((x) => <OtherUnitRow key={x.group.key} x={x} />)}
          <li>
            {finding
              ? <RegistryFind item={item} index={index} onPick={(g) => { onPick(i, g); setFinding(false) }} onClose={() => setFinding(false)} />
              : <button type="button" className="kpr-link-btn" onClick={() => setFinding(true)}>найти в реестре</button>}
          </li>
        </ul>
      </td>
    </tr>
  )
})

// Ступень похожести — коротко (utils/supplyDocMatch.gradeNames).
const GRADE_SHORT = { same: 'та же позиция', close: 'очень похоже', refine: 'уточнённая модель', near: 'похоже', far: 'отдалённо' }
const entryLabel = (c) => {
  if (c.manual) return c.exact ? 'то же наименование · найдено поиском' : 'найдено поиском'
  if (c.exact) return 'то же наименование'
  if (c.article || c.code) return `артикул совпал · ${pct(c.score)}`
  if (c.apart) return 'другой размер или марка'
  return c.grade ? `${GRADE_SHORT[c.grade]} · ${pct(c.score)}` : `похоже на ${pct(c.score)}`
}
// Цена старше 3 месяцев — с красной пометкой (решение пользователя 26.11.2026).
const staleDate = (iso) => !isFreshPriceDate(moscowDay(iso))
const Stale = () => <span className="kpr-stale">старше 3 месяцев</span>
const fmtFactor = (n) => String(Math.round(n * 10000) / 10000).replace('.', ',')

// Позиция реестра у строки: галочка «учитывать», цены за единицу строки файла и откуда они; все цены — по нажатию.
function RegistryEntry({ e, i, item, onToggle }) {
  const [open, setOpen] = useState(false)
  const { group, c, points, factor } = e
  const unit = factor !== 1 ? item.unit : group.unit
  const prices = points.map((p) => p.price)
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  const newest = points[0]
  return (
    <li className={`kpr-analog has-check is-grade-${e.grade || 'manual'}${e.on ? '' : e.auto ? ' is-off is-removed' : ' is-off'}`}>
      <input type="checkbox" checked={e.on} onChange={(ev) => onToggle(i, e.key, ev.target.checked)} aria-label={`Учитывать: ${group.name}`} />
      <span className="kpr-analog-name">{group.name}</span>
      <span className="kpr-analog-price">{lo === hi ? fmtMoney(lo) : `${fmtMoney(lo)}–${fmtMoney(hi)}`} ₽{unit ? ` / ${unit}` : ''}</span>
      <span className="kpr-analog-meta">
        <span className="kpr-score">{entryLabel(c)}</span>
        {factor !== 1 && <span>1 {item.unit} = {fmtFactor(factor)} {group.unit}, в реестре {fmtMoney(Number(newest.row.price))} ₽ / {group.unit}</span>}
        <span>{fmtMoscowDate(newest.row.rate_date)}</span>
        {staleDate(newest.row.rate_date) && <Stale />}
        {newest.row.object_name && <span>{newest.row.object_name}</span>}
        <span>{newest.row.source_name || 'СУ-10'}</span>
        {newest.row.contractor_label && <span>{newest.row.contractor_label}</span>}
        {newest.row.tender_id && newest.row.tender_desc && (
          <a href={`/tenders/${newest.row.tender_id}`} target="_blank" rel="noopener noreferrer">{newest.row.tender_desc}</a>
        )}
        {isWebLink(newest.row.invoice_url) && <a href={newest.row.invoice_url} target="_blank" rel="noopener noreferrer">счёт</a>}
        {points.length > 1 && (
          <button type="button" className="kpr-link-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'скрыть цены' : `все цены: ${points.length}`}
          </button>
        )}
      </span>
      {open && (
        <ul className="kpr-points">
          {points.slice(0, POINTS_LIMIT).map((p) => (
            <li key={p.row.id}>
              <span className="kpr-num">{fmtMoscowDate(p.row.rate_date)}</span>
              {staleDate(p.row.rate_date) && <Stale />}
              <b className="kpr-num">{fmtMoney(p.price)} ₽</b>
              {p.row.object_name && <span>{p.row.object_name}</span>}
              <span>{p.row.source_name || 'СУ-10'}</span>
              {p.row.contractor_label && <span>{p.row.contractor_label}</span>}
              {p.row.tender_id && p.row.tender_desc && (
                <a href={`/tenders/${p.row.tender_id}`} target="_blank" rel="noopener noreferrer">{p.row.tender_desc}</a>
              )}
              {isWebLink(p.row.invoice_url) && <a href={p.row.invoice_url} target="_blank" rel="noopener noreferrer">счёт</a>}
            </li>
          ))}
          {points.length > POINTS_LIMIT && <li className="kpr-muted">и ещё {points.length - POINTS_LIMIT} — в выгрузке реестра</li>}
        </ul>
      )}
    </li>
  )
}

function OtherUnitRow({ x }) {
  const prices = x.rows.map((r) => Number(r.price))
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  return (
    <li className="kpr-analog is-other-unit">
      <span className="kpr-analog-name">{x.group.name}</span>
      <span className="kpr-analog-price">{lo === hi ? fmtMoney(lo) : `${fmtMoney(lo)}–${fmtMoney(hi)}`} ₽{x.group.unit ? ` / ${x.group.unit}` : ''}</span>
      <span className="kpr-analog-meta">
        <span className="kpr-score">другая ед. изм.</span>
        <span>цен: {x.rows.length}</span>
      </span>
    </li>
  )
}

// Найти позицию поиском по реестру (как «Найти позицию ВОР» в окне счетов тендера на материалы): слова запроса в наименовании, при
// равенстве — похожесть. Выбранная идёт в сравнение строки.
function RegistryFind({ item, index, onPick, onClose }) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState({ q: '', list: [] })
  const q = query.trim()
  useEffect(() => {
    if (!q || !index) return undefined
    const t = setTimeout(() => setResult({ q, list: searchGroups(q, index.groups, FIND_LIMIT) }), FIND_DELAY_MS)
    return () => clearTimeout(t)
  }, [q, index])
  const found = q && result.q === q ? result.list : []
  return (
    <div className="kpr-find">
      <label className="kpr-find-input">
        <IconSearch size={14} />
        <input type="search" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} placeholder="Найти в реестре"
          aria-label={`Найти позицию реестра для «${item.name}»`}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); if (query) setQuery(''); else onClose() } }} />
      </label>
      {found.length > 0 && (
        <ul className="kpr-find-list">
          {found.map((g) => (
            <li key={g.key}>
              <button type="button" className="kpr-find-opt" onClick={() => onPick(g)}>
                <span>{g.name}</span>
                <span className="kpr-muted kpr-num">{g.unit || 'ед. изм. не указана'} · цен: {g.rows.length}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {q && result.q === q && !found.length && <p className="kpr-muted">Ничего не нашли</p>}
      <button type="button" className="kpr-link-btn" onClick={onClose}>отмена</button>
    </div>
  )
}
