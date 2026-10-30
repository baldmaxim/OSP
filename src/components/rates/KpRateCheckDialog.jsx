import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FilterDropdown from '../FilterDropdown'
import PaperclipIcon from '../icons/PaperclipIcon'
import { IconUpload } from '../icons/BsmIcons'
import { IconAlert } from '../icons/ActionIcons'
import { IconClose } from '../icons/ToolbarIcons'
import { DEFAULT_VAT_RATE } from '../../utils/supplierDoc'
import { isPdfFile, isSheetFile } from '../../utils/supplierDocRead'
import { BID_DOC_ACCEPT, DOC_ERROR_TEXT, readBidPriceDoc } from '../../utils/bidImport'
import {
  CHECK_EXPORT_HEADERS, DEFAULT_TOLERANCE, TOLERANCE_STEPS, VERDICT_TEXT, VISIBLE_ANALOGS,
  checkExportRows, checkLines, checkSummary, lineKind,
} from '../../utils/kpRateCheck'
import { moscowToday, tenderLabel } from '../../utils/kpRegistrySources'
import { fmtMoney, fmtDate, downloadXlsx, todayStamp } from '../../utils/ratesRegistry'
import { insertManualRates, lookupSimilarRates } from '../../services/kpManualRates'
import { loadOptionsOnce } from './KpManualRateDialog'
import './KpRates.css'

// Больше — не распознаём (страница подвисла бы на разборе).
const PARSE_MAX_BYTES = 30 * 1024 * 1024
// Больше строк за одну проверку не ищем (поиск похожих — ~30 мс на строку в базе).
const LINES_MAX = 600

const VAT_TEXT = { gross: 'цены с НДС', net: 'цены без НДС — НДС добавится', none: 'НДС не облагается — цены как есть' }
const KIND_OPTIONS = [['all', 'материалы и работы'], ['material', 'материалы'], ['work', 'работы']]
const pct = (s) => `${Math.round(s * 100)} %`
const fmtDev = (d) => (d == null ? '—' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${String(Math.abs(d)).replace('.', ',')} %`)

// Проверка расценок по файлу (реестр КП): файл подрядчика или поставщика (заполненный ВОР, КП, счёт, прайс — Excel,
// CSV, PDF с текстом) распознаётся, как «Цены из счёта / КП» расценки снабжением; у каждой строки — похожие расценки
// реестра (то же наименование, затем похожие той же ед. изм.), их минимум, медиана, максимум и отклонение цены файла
// от медианы. Итог — в рынке / дороже / дешевле (допуск — на выбор), выгрузка в Excel. canAdd — право правки реестра:
// отмеченные строки можно добавить в реестр расценками подрядчика (файл — документом), onAdded({ count, fileError }).
export default function KpRateCheckDialog({ canAdd = false, onClose, onAdded }) {
  const [phase, setPhase] = useState('pick') // pick | reading | lookup | review | adding
  const [file, setFile] = useState(null)
  const [readError, setReadError] = useState('')
  const [doc, setDoc] = useState(null) // { kind, items, vat, sheetName | pages }
  const [found, setFound] = useState(null) // Map индекс строки → строки реестра
  const [progress, setProgress] = useState(null)
  const [vatMode, setVatMode] = useState('auto')
  const [vatRate, setVatRate] = useState(String(DEFAULT_VAT_RATE))
  const [compareKind, setCompareKind] = useState('all')
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE)
  const [filter, setFilter] = useState('all')
  const [checked, setChecked] = useState(() => new Set())
  const [dragOver, setDragOver] = useState(false)
  const [addError, setAddError] = useState('')
  const [add, setAdd] = useState(() => ({ counterparty_id: '', tender_id: '', object_id: '', rate_date: moscowToday(), kind: 'material', attach: true }))
  const [options, setOptions] = useState(null)
  const fileRef = useRef(null)
  const abortRef = useRef(null)
  const busy = phase === 'reading' || phase === 'lookup' || phase === 'adding'

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || phase === 'adding' || document.querySelector('.fdrop-panel')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, onClose])
  useEffect(() => () => abortRef.current?.abort(), [])

  // Справочники для «Добавить в реестр» — только тому, кто может добавить.
  useEffect(() => {
    if (!canAdd) return undefined
    let cancelled = false
    loadOptionsOnce().then((o) => { if (!cancelled) setOptions(o) }).catch(() => { /* подсказка — при добавлении */ })
    return () => { cancelled = true }
  }, [canAdd])

  // ── Чтение файла и поиск похожих ──────────────────────────────────────────────────────────────────
  const readOne = async (f) => {
    abortRef.current?.abort()
    setFile(f)
    setReadError('')
    setDoc(null)
    setFound(null)
    setChecked(new Set())
    if (!isPdfFile(f.name) && !isSheetFile(f.name)) { setReadError(DOC_ERROR_TEXT.unsupported); return }
    if (f.size > PARSE_MAX_BYTES) { setReadError(`Файл больше ${PARSE_MAX_BYTES / 1024 / 1024} МБ — такой не распознаём.`); return }
    setPhase('reading')
    let r
    try {
      r = await readBidPriceDoc(new Uint8Array(await f.arrayBuffer()), f.name)
    } catch (e) {
      r = { error: 'broken', message: e.message }
    }
    if (r.error) {
      setReadError(`${DOC_ERROR_TEXT[r.error] || DOC_ERROR_TEXT.broken}${r.message ? ` (${r.message})` : ''}`)
      setPhase('pick')
      return
    }
    const items = r.items.slice(0, LINES_MAX)
    const parsed = { ...r, items, cut: r.items.length - items.length }
    setDoc(parsed)
    setVatMode('auto')
    setVatRate(String(r.vat?.rate ?? DEFAULT_VAT_RATE))
    setFilter('all')
    if (items.some((it) => it.kindHint) && items.every((it) => it.kindHint || it.delivery)) setAdd((a) => ({ ...a, kind: 'file' }))
    await runLookup(parsed)
  }

  // Строки ищутся только среди своего вида, если он известен из файла (листы «Материалы» / «Работы»), иначе — среди
  // обоих: смена «Сравнивать с» тогда не требует нового поиска.
  const runLookup = async (parsed) => {
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('lookup')
    setProgress({ done: 0, total: parsed.items.length })
    try {
      const names = parsed.items.map((it) => (it.delivery ? '' : it.name))
      const kinds = parsed.items.map((it) => it.kindHint || null)
      const map = await lookupSimilarRates(names, kinds, { signal: controller.signal, onProgress: (done, total) => setProgress({ done, total }) })
      if (controller.signal.aborted) return
      setFound(map)
      setPhase('review')
    } catch (e) {
      if (controller.signal.aborted) return
      setReadError(`Похожие расценки не найдены: ${e.message || e}`)
      setPhase('pick')
    }
  }

  const pickFiles = (list) => {
    const f = [...(list || [])][0]
    if (f && !busy) readOne(f)
  }

  // ── Строки проверки ───────────────────────────────────────────────────────────────────────────────
  const vat = useMemo(() => {
    if (!doc) return null
    if (vatMode === 'auto') return doc.vat
    const rate = Number(String(vatRate).replace(',', '.'))
    return { mode: vatMode, rate: Number.isFinite(rate) && rate >= 0 && rate < 100 ? rate : DEFAULT_VAT_RATE, force: true }
  }, [doc, vatMode, vatRate])

  // «Сравнивать с» — фильтр найденного по виду (строки с видом из файла — всегда со своим).
  const rowsByIdx = useMemo(() => {
    if (!found || !doc) return new Map()
    if (compareKind === 'all') return found
    const out = new Map()
    for (const [i, rows] of found) {
      const k = lineKind(doc.items[i], compareKind)
      out.set(i, k ? rows.filter((r) => r.item_type === k) : rows)
    }
    return out
  }, [found, doc, compareKind])

  const lines = useMemo(() => (doc && found ? checkLines(doc.items, rowsByIdx, { vat, tolerance }) : []), [doc, found, rowsByIdx, vat, tolerance])
  const summary = useMemo(() => checkSummary(lines), [lines])
  const goods = lines.filter((l) => l.verdict !== 'delivery')
  const shown = goods.filter((l) => filter === 'all' || l.verdict === filter)
  const toAdd = goods.filter((l) => checked.has(l.i) && l.price != null)

  const toggle = useCallback((i, on) => setChecked((prev) => {
    const next = new Set(prev)
    if (on) next.add(i); else next.delete(i)
    return next
  }), [])
  const allShownChecked = shown.length > 0 && shown.every((l) => l.price == null || checked.has(l.i))
  const toggleShown = (on) => setChecked((prev) => {
    const next = new Set(prev)
    for (const l of shown) { if (l.price == null) continue; if (on) next.add(l.i); else next.delete(l.i) }
    return next
  })

  const exportXlsx = () => {
    const base = (file?.name || 'файл').replace(/\.[^.]+$/, '')
    downloadXlsx(CHECK_EXPORT_HEADERS, checkExportRows(lines), 'Проверка расценок', `Проверка расценок — ${base} ${todayStamp()}.xlsx`,
      [5, 50, 9, 9, 14, 10, 12, 12, 12, 12, 16, 44, 26, 34, 12, 14])
  }

  // ── Добавить в реестр ─────────────────────────────────────────────────────────────────────────────
  const fileHasKinds = !!doc && doc.items.some((it) => it.kindHint)
  const tenderById = useMemo(() => new Map((options?.tenders || []).map((t) => [t.id, t])), [options])
  const setAddField = (key) => (value) => setAdd((a) => ({ ...a, [key]: value }))
  const pickTender = (id) => setAdd((a) => ({ ...a, tender_id: id, object_id: a.object_id || (tenderById.get(id)?.object_id ?? '') }))
  const addToRegistry = async () => {
    setAddError('')
    if (!add.counterparty_id) { setAddError('Выберите подрядчика, чьи это расценки'); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(add.rate_date)) { setAddError('Укажите дату расценки'); return }
    const rows = toAdd.map((l) => ({
      item_type: (add.kind === 'file' ? l.item.kindHint : null) || (add.kind === 'work' ? 'work' : 'material'),
      item_name: l.item.name.slice(0, 1000),
      unit: l.item.unit ? l.item.unit.slice(0, 50) : null,
      price: l.price,
      counterparty_id: add.counterparty_id,
      object_id: add.object_id || null,
      tender_id: add.tender_id || null,
      rate_date: add.rate_date,
      note: l.item.code ? `арт. ${l.item.code}`.slice(0, 2000) : null,
    }))
    setPhase('adding')
    setProgress({ done: 0, total: rows.length })
    try {
      const res = await insertManualRates(rows, { file: add.attach ? file : null, onProgress: (done, total) => setProgress({ done, total }) })
      onAdded({ count: res.ids.length, fileError: res.fileError })
    } catch (e) {
      setAddError(e.message || String(e))
      setPhase('review')
    }
  }

  // ── Отрисовка ─────────────────────────────────────────────────────────────────────────────────────
  const inReview = (phase === 'review' || phase === 'adding') && !!doc && !!found
  const cpOptions = useMemo(() => [{ value: '', label: 'Выберите подрядчика' },
    ...(options?.counterparties || []).map((c) => ({ value: c.id, label: c.name }))], [options])
  const tenderOptions = useMemo(() => [{ value: '', label: 'Без тендера' },
    ...(options?.tenders || []).map((t) => ({ value: t.id, label: tenderLabel(t) }))], [options])
  const objectOptions = useMemo(() => [{ value: '', label: add.tender_id ? 'Объект тендера' : 'Без объекта' },
    ...(options?.objects || []).map((o) => ({ value: o.id, label: o.name }))], [options, add.tender_id])

  return (
    <div className="kpr-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className={`kpr-modal${inReview ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="kpr-check-title">
        <div className="kpr-modal-head">
          <h3 id="kpr-check-title">Проверка расценок по файлу</h3>
          <button type="button" className="kpr-icon-btn" onClick={onClose} disabled={phase === 'adding'} aria-label="Закрыть"><IconClose size={16} /></button>
        </div>
        <div className="kpr-modal-body">
          {!inReview && (
            <>
              <p className="kpr-muted">
                Загрузите КП, счёт, прайс или заполненный ВОР подрядчика (Excel, CSV или PDF с текстом): строки с ценами
                распознаются так же, как «Цены из счёта / КП» в расценке снабжением, и у каждой строки найдутся похожие
                расценки реестра — то же наименование или похожее, с той же ед. изм. Покажем, дороже или дешевле цена файла,
                чем обычно в реестре.{canAdd ? ' Отмеченные строки можно добавить в реестр расценками подрядчика.' : ''}
              </p>
              <div className={`kpr-drop${dragOver ? ' is-over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFiles(e.dataTransfer.files) }}>
                <input ref={fileRef} type="file" accept={BID_DOC_ACCEPT} hidden onChange={(e) => { pickFiles(e.target.files); e.target.value = '' }} />
                <button type="button" className="kpr-btn kpr-btn-primary" onClick={() => fileRef.current?.click()} disabled={busy}>
                  <IconUpload size={16} /> Выбрать файл
                </button>
                <span className="kpr-muted">или перетащите сюда · Excel (.xlsx, .xls, .csv) или PDF</span>
              </div>
              {phase === 'reading' && <p className="kpr-progress" role="status">Распознаём «{file?.name}»…</p>}
              {phase === 'lookup' && progress && (
                <p className="kpr-progress" role="status">Ищем похожие расценки в реестре: {progress.done} из {progress.total} строк…</p>
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
                  {' · '}строк с ценой: <b className="kpr-num">{summary.total}</b>
                  {doc.cut > 0 ? ` (проверены первые ${LINES_MAX}, ещё ${doc.cut} — следующим файлом)` : ''}
                </span>
                <button type="button" className="kpr-link-btn" onClick={() => { setPhase('pick'); setDoc(null); setFound(null) }} disabled={busy}>другой файл</button>
              </div>

              <div className="kpr-settings">
                <fieldset disabled={busy}>
                  <legend>НДС цен файла</legend>
                  <label>
                    <input type="radio" name="kpr-vat" checked={vatMode === 'auto'} onChange={() => setVatMode('auto')} />
                    как в документе{doc.vat?.mode ? ` — ${VAT_TEXT[doc.vat.mode]}` : ' — колонки «с НДС» / «без НДС», иначе как есть'}
                    {doc.vat?.cue && <span className="kpr-muted"> (в документе: «{doc.vat.cue}»)</span>}
                  </label>
                  <label><input type="radio" name="kpr-vat" checked={vatMode === 'gross'} onChange={() => setVatMode('gross')} /> цены с НДС — как есть</label>
                  <label>
                    <input type="radio" name="kpr-vat" checked={vatMode === 'net'} onChange={() => setVatMode('net')} /> цены без НДС — добавить
                    <input type="text" inputMode="decimal" className="kpr-rate" value={vatRate} onChange={(e) => setVatRate(e.target.value)}
                      onFocus={() => setVatMode('net')} aria-label="Ставка НДС, %" /> %
                  </label>
                </fieldset>
                <fieldset disabled={busy}>
                  <legend>Сравнивать с расценками</legend>
                  {KIND_OPTIONS.map(([k, label]) => (
                    <label key={k}><input type="radio" name="kpr-kind-cmp" checked={compareKind === k} onChange={() => setCompareKind(k)} /> {label}</label>
                  ))}
                  {fileHasKinds && <span className="kpr-muted">строки листов «Материалы» / «Работы» — со своим видом</span>}
                </fieldset>
                <fieldset disabled={busy}>
                  <legend>Допуск от медианы реестра</legend>
                  <label>
                    ±
                    <select value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} aria-label="Допуск, %">
                      {TOLERANCE_STEPS.map((t) => <option key={t} value={t}>{t} %</option>)}
                    </select>
                    — «в рынке»
                  </label>
                </fieldset>
              </div>

              <div className="kpr-filters" role="group" aria-label="Показать строки">
                {[['all', 'Все', summary.total], ['high', 'Дороже реестра', summary.high], ['low', 'Дешевле реестра', summary.low],
                  ['ok', 'В рынке', summary.ok], ['none', 'Нет аналогов', summary.none], ['noprice', 'Нет цены', summary.noprice]]
                  .filter(([k, , n]) => k === 'all' || n > 0)
                  .map(([k, label, n]) => (
                    <button key={k} type="button" className={`kpr-filter${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                      {label}<span className="kpr-num">{n}</span>
                    </button>
                  ))}
              </div>

              {canAdd && (
                <div className="kpr-add">
                  <p className="kpr-add-title">Добавить отмеченные строки в реестр расценками подрядчика (отмечено: {toAdd.length})</p>
                  <div className="kpr-field">
                    <span className="kpr-label">Подрядчик</span>
                    <FilterDropdown label="" searchable searchPlaceholder="Поиск подрядчика…" allLabel="Выберите подрядчика"
                      value={add.counterparty_id} onChange={setAddField('counterparty_id')} options={cpOptions} disabled={busy || !options} />
                  </div>
                  <div className="kpr-field">
                    <span className="kpr-label">Тендер</span>
                    <FilterDropdown label="" searchable searchPlaceholder="Номер или описание…" allLabel="Без тендера"
                      value={add.tender_id} onChange={pickTender} options={tenderOptions} disabled={busy || !options} />
                  </div>
                  <div className="kpr-field">
                    <span className="kpr-label">Объект</span>
                    <FilterDropdown label="" searchable searchPlaceholder="Поиск объекта…" allLabel={add.tender_id ? 'Объект тендера' : 'Без объекта'}
                      value={add.object_id} onChange={setAddField('object_id')} options={objectOptions} disabled={busy || !options} />
                  </div>
                  <div className="kpr-field">
                    <label htmlFor="kpr-add-date">Дата расценки</label>
                    <input id="kpr-add-date" type="date" value={add.rate_date} disabled={busy} onChange={(e) => setAddField('rate_date')(e.target.value)} />
                  </div>
                  <div className="kpr-field">
                    <label htmlFor="kpr-add-kind">Вид позиций</label>
                    <select id="kpr-add-kind" value={add.kind} disabled={busy} onChange={(e) => setAddField('kind')(e.target.value)}>
                      {fileHasKinds && <option value="file">как в файле (листы)</option>}
                      <option value="material">материалы</option>
                      <option value="work">работы</option>
                    </select>
                  </div>
                </div>
              )}

              <div className="kpr-table-wrap">
                <table className="kpr-table">
                  <colgroup>
                    {canAdd && <col className="kpr-c-sel" />}
                    <col className="kpr-c-line" /><col className="kpr-c-price" /><col className="kpr-c-reg" /><col className="kpr-c-dev" /><col />
                  </colgroup>
                  <thead>
                    <tr>
                      {canAdd && (
                        <th>
                          <input type="checkbox" checked={allShownChecked} disabled={busy || !shown.length} onChange={(e) => toggleShown(e.target.checked)}
                            aria-label="Отметить все показанные строки с ценой" />
                        </th>
                      )}
                      <th>Строка файла</th>
                      <th className="kpr-money">Цена с НДС, ₽</th>
                      <th>Реестр: мин. · медиана · макс.</th>
                      <th>Отклонение</th>
                      <th>Ближайшие расценки реестра</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((l) => (
                      <CheckLine key={l.i} line={l} canAdd={canAdd} checked={checked.has(l.i)} busy={busy} onCheck={toggle} />
                    ))}
                    {!shown.length && <tr><td colSpan={canAdd ? 6 : 5} className="kpr-muted">Строк нет</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {addError && <p className="kpr-error" role="alert">{addError}</p>}
        </div>
        <div className="kpr-modal-foot">
          {inReview && canAdd && (
            <label className="kpr-foot-note">
              <input type="checkbox" checked={add.attach} disabled={busy} onChange={(e) => setAddField('attach')(e.target.checked)} />
              {' '}прикрепить файл документом к добавленным расценкам
            </label>
          )}
          {phase === 'adding' && progress && <span className="kpr-progress" role="status">Добавляем: {progress.done} из {progress.total}…</span>}
          {inReview && <button type="button" className="kpr-btn" onClick={exportXlsx} disabled={busy || !goods.length}>Выгрузить проверку в Excel</button>}
          <button type="button" className="kpr-btn" onClick={onClose} disabled={phase === 'adding'}>Закрыть</button>
          {inReview && canAdd && (
            <button type="button" className="kpr-btn kpr-btn-primary" onClick={addToRegistry} disabled={busy || !toAdd.length}>
              {phase === 'adding' ? 'Добавляем…' : `Добавить в реестр: ${toAdd.length}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// Строка проверки: строка файла, её цена с НДС, цены аналогов реестра, отклонение и ближайшие расценки.
const CheckLine = memo(function CheckLine({ line, canAdd, checked, busy, onCheck }) {
  const [more, setMore] = useState(false)
  const { item, price, stats, dev, verdict, analogs, otherUnit } = line
  const list = more ? analogs : analogs.slice(0, VISIBLE_ANALOGS)
  return (
    <tr>
      {canAdd && (
        <td>
          <input type="checkbox" checked={checked} disabled={busy || price == null} onChange={(e) => onCheck(line.i, e.target.checked)}
            aria-label={`Отметить: ${item.name}`} />
        </td>
      )}
      <td>
        <div className="kpr-line-name">{item.name}</div>
        <div className="kpr-meta">
          {item.kindHint && <span>{item.kindHint === 'work' ? 'работа' : 'материал'}</span>}
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
            <span className="kpr-muted">аналогов: {stats.n}{stats.exact ? `, то же наименование: ${stats.exact}` : ''}</span>
          </div>
        ) : (
          <span className="kpr-muted">{otherUnit.length ? `аналоги только в другой ед. изм.: ${otherUnit.length}` : 'аналогов нет'}</span>
        )}
      </td>
      <td>
        <span className={`kpr-verdict is-${verdict}`}>{VERDICT_TEXT[verdict]}</span>
        {dev != null && <div className="kpr-num kpr-muted">{fmtDev(dev)} к медиане</div>}
      </td>
      <td>
        {analogs.length + otherUnit.length === 0 ? <span className="kpr-muted">—</span> : (
          <ul className="kpr-analogs">
            {list.map((c) => <Analog key={c.group.key} c={c} />)}
            {!more && otherUnit.slice(0, Math.max(0, VISIBLE_ANALOGS - list.length)).map((c) => <Analog key={c.group.key} c={c} otherUnit />)}
            {analogs.length > VISIBLE_ANALOGS && (
              <li><button type="button" className="kpr-link-btn" onClick={() => setMore((m) => !m)}>
                {more ? 'свернуть' : `ещё ${analogs.length - VISIBLE_ANALOGS}`}
              </button></li>
            )}
          </ul>
        )}
      </td>
    </tr>
  )
})

function Analog({ c, otherUnit = false }) {
  const r = c.row ?? c.group.row
  return (
    <li className={`kpr-analog${otherUnit ? ' is-other-unit' : ''}`}>
      <span className="kpr-analog-name">{r.item_name}</span>
      <span className="kpr-analog-price">{fmtMoney(r.price)} ₽{r.unit ? ` / ${r.unit}` : ''}</span>
      <span className="kpr-analog-meta">
        <span className="kpr-score">{c.exact ? 'то же наименование' : c.code ? `артикул совпал · ${pct(c.score)}` : `похоже на ${pct(c.score)}`}</span>
        {otherUnit && <span>другая ед. изм.</span>}
        <span>{r.item_type === 'work' ? 'работа' : 'материал'}</span>
        {r.counterparty_name && <span>{r.counterparty_name}</span>}
        {r.tender_id && r.tender_desc && <a href={`/tenders/${r.tender_id}`} target="_blank" rel="noopener noreferrer">{r.tender_desc}</a>}
        {r.source_kind === 'manual' && <span>добавлено вручную</span>}
        {r.estimate_name && <span>ВОР: {r.estimate_name}</span>}
        {r.proposal_date && <span>{fmtDate(r.proposal_date)}</span>}
      </span>
    </li>
  )
}
