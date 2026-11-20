import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PaperclipIcon from '../icons/PaperclipIcon'
import { IconAlert } from '../icons/ActionIcons'
import { IconClose } from '../icons/ToolbarIcons'
import { IconUpload } from '../icons/BsmIcons'
import { readWorkbookBytes } from '../../utils/supplierDocRead'
import {
  DEFAULT_SOURCE, PARSE_ERROR_TEXT, PRIMAVERA_ONCE, REGISTRY_IMPORT_ACCEPT,
  isBarePrimavera, moscowDay, objectIndex, parseRegistryWorkbook, prepareRegistryImport, primaveraK14, primaveraOnceUsed,
} from '../../utils/supplyRegistryImport'
import { fmtMoney, fmtCount } from '../../utils/ratesRegistry'
import { deleteImport, importRegistryRates, listImports, loadImportContext } from '../../services/supplyRegistryImport'
import './KpRates.css'
import './SupplyRegistryImport.css'

// Больше — не читаем (страница подвисла бы на разборе).
const PARSE_MAX_BYTES = 30 * 1024 * 1024
// Сколько строк файла показывать в таблице окна (пишутся все).
const LINES_SHOWN = 300

const STATUS_TEXT = { ok: 'к загрузке', exists: 'уже в реестре', dup: 'повтор в файле', error: 'ошибка' }
const FILTERS = [['all', 'Все'], ['ok', 'К загрузке'], ['exists', 'Уже в реестре'], ['dup', 'Повтор в файле'], ['error', 'С ошибкой']]
const fmtDay = (d) => (d ? d.split('-').reverse().join('.') : '—')
const fmtStamp = (iso) => {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Реестр расценок → «Расценки от снабжения СУ-10» → «Загрузить из Excel». Файл — как выгрузка вкладки (№ п/п, Источник,
// Объект, Наименование, Ед. изм., Цена, Тендер, Дата расценки); строки распознаются как «Счета и КП» расценки снабжения
// (utils/supplyRegistryImport), объект — по неочевидному названию, нераспознанный выбирается здесь же. Записывается только
// по кнопке; такие же расценки (уже в реестре, повтор в файле) не пишутся. Внизу — прежние загрузки с удалением.
// onImported({ added, skipped, fileName }), onChanged() — удалили загрузку.
export default function SupplyRegistryImportDialog({ onClose, onImported, onChanged }) {
  const [ctx, setCtx] = useState(null) // { objects, tenders, existing, imports }
  const [ctxError, setCtxError] = useState('')
  const [phase, setPhase] = useState('pick') // pick | reading | review | saving
  const [file, setFile] = useState(null)
  const [parsed, setParsed] = useState(null) // { rows, sheetName, columns }
  const [readError, setReadError] = useState('')
  const [choices, setChoices] = useState(() => new Map())
  const [defaults, setDefaults] = useState(() => ({ source: DEFAULT_SOURCE, date: moscowDay(new Date()) }))
  const [primaveraOnce, setPrimaveraOnce] = useState(true)
  const [filter, setFilter] = useState('all')
  const [progress, setProgress] = useState(null)
  const [saveError, setSaveError] = useState('')
  const [over, setOver] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const fileRef = useRef(null)
  const busy = phase === 'reading' || phase === 'saving' || !!deleting

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && phase !== 'saving') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, onClose])

  useEffect(() => {
    let cancelled = false
    loadImportContext()
      .then((c) => { if (!cancelled) setCtx(c) })
      .catch((err) => { if (!cancelled) setCtxError(err.message || String(err)) })
    return () => { cancelled = true }
  }, [])

  const index = useMemo(() => objectIndex(ctx?.objects), [ctx])
  const objectsSorted = useMemo(() => [...index].sort((a, b) => a.name.localeCompare(b.name, 'ru')), [index])
  const today = useMemo(() => moscowDay(new Date()), [])

  // ── Разово: «Primavera» без корпуса = к14 (utils/supplyRegistryImport, PRIMAVERA_ONCE) ─────────────────
  const onceAvailable = !!ctx && !primaveraOnceUsed(ctx.imports) && !!primaveraK14(index)
  const onceInFile = onceAvailable && !!parsed?.rows.some((r) => isBarePrimavera(r.object))

  const prepared = useMemo(() => {
    if (!parsed || !ctx) return null
    return prepareRegistryImport(parsed.rows, {
      index, tenders: ctx.tenders, existing: ctx.existing, choices, primaveraOnce: onceInFile && primaveraOnce, defaults, today,
    })
  }, [parsed, ctx, index, choices, onceInFile, primaveraOnce, defaults, today])

  const readFile = useCallback(async (f) => {
    if (!f) return
    setFile(f)
    setReadError('')
    setSaveError('')
    if (!/\.(xlsx|xlsm|xlsb|xls|ods|csv)$/i.test(f.name)) { setReadError('Нужен файл Excel (.xlsx, .xls) или CSV.'); return }
    if (f.size > PARSE_MAX_BYTES) { setReadError('Файл больше 30 МБ — разделите его.'); return }
    setPhase('reading')
    try {
      const XLSX = await import('xlsx')
      const wb = readWorkbookBytes(XLSX, new Uint8Array(await f.arrayBuffer()), f.name)
      const res = parseRegistryWorkbook(XLSX, wb)
      if (res.error) {
        setReadError(PARSE_ERROR_TEXT[res.error] || 'Файл не распознан.')
        setPhase('pick')
        return
      }
      setParsed(res)
      setChoices(new Map())
      setFilter('all')
      setPhase('review')
    } catch (err) {
      console.error('Загрузка расценок СУ-10: файл не прочитан', err)
      setReadError(PARSE_ERROR_TEXT.broken)
      setPhase('pick')
    }
  }, [])
  const pickFiles = (files) => { if (!busy && files?.length) readFile(files[0]) }

  const chooseObject = (label, value) => setChoices((prev) => new Map(prev).set(label, value))

  const toImport = useMemo(() => prepared?.lines.filter((l) => l.status === 'ok') || [], [prepared])
  const shown = useMemo(() => {
    const all = prepared?.lines || []
    return filter === 'all' ? all : all.filter((l) => l.status === filter)
  }, [prepared, filter])
  // Названия объектов из файла: сначала те, где нужен выбор.
  const labels = useMemo(() => [...(prepared?.labels || [])].sort((a, b) => (!!a.objectId - !!b.objectId)
    || (a.label ? 0 : 1) - (b.label ? 0 : 1) || b.count - a.count), [prepared])
  const unresolvedRows = toImport.filter((l) => !l.objectId).length
  const hasEmptyDate = !!parsed?.rows.some((r) => r.date === '')
  const hasEmptySource = !!parsed?.rows.some((r) => !r.source)

  const save = async () => {
    if (!toImport.length || !prepared) return
    if (unresolvedRows && !window.confirm(`У ${fmtCount(unresolvedRows)} из ${fmtCount(toImport.length)} строк объект портала не выбран — они попадут в реестр без него (с названием объекта из файла, если оно есть), фильтр «Объект» их не найдёт. Загрузить так?`)) return
    setPhase('saving')
    setSaveError('')
    setProgress({ done: 0, total: toImport.length })
    // Разовое правило — в настройки загрузки, только если им определён объект хоть одной записываемой строки.
    const onceLabels = new Set(prepared.labels.filter((l) => l.once && l.objectId === l.auto).map((l) => l.label))
    const onceUsed = toImport.some((l) => onceLabels.has(l.object))
    const options = onceUsed ? { [PRIMAVERA_ONCE.key]: PRIMAVERA_ONCE.value } : {}
    try {
      const res = await importRegistryRates(file.name, options, toImport, { onProgress: (done, total) => setProgress({ done, total }) })
      onImported({ ...res, fileName: file.name })
    } catch (err) {
      setSaveError(err.message || String(err))
      setPhase('review')
      // Список загрузок мог измениться (прерванная загрузка убрана или осталась).
      listImports().then((imports) => setCtx((c) => (c ? { ...c, imports } : c))).catch(() => {})
    } finally {
      setProgress(null)
    }
  }

  const removeImport = async (imp) => {
    const rows = imp.rows != null ? ` (${fmtCount(imp.rows)} строк)` : ''
    if (!window.confirm(`Удалить загрузку «${imp.file_name}» от ${fmtStamp(imp.created_at)}${rows} из реестра? Расценки этой загрузки пропадут из реестра.`)) return
    setDeleting(imp.id)
    try {
      await deleteImport(imp.id)
      // Ключи «уже в реестре» после удаления — заново: иначе тот же файл показал бы свои строки загруженными.
      setCtx(await loadImportContext())
      onChanged?.()
    } catch (err) {
      alert(err.message || String(err))
    } finally {
      setDeleting(null)
    }
  }

  const dropProps = {
    onDragOver: (e) => { e.preventDefault(); setOver(true) },
    onDragLeave: (e) => { if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) setOver(false) },
    onDrop: (e) => { e.preventDefault(); setOver(false); pickFiles(e.dataTransfer.files) },
  }
  const inReview = (phase === 'review' || phase === 'saving') && !!prepared

  return (
    <div className="kpr-backdrop" role="presentation" {...dropProps} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className={`kpr-modal${inReview ? ' is-wide' : ''}${over ? ' is-over' : ''}`} role="dialog" aria-modal="true" aria-labelledby="sri-title">
        <div className="kpr-modal-head">
          <h3 id="sri-title">Загрузка расценок СУ-10 из Excel</h3>
          <button type="button" className="kpr-icon-btn" onClick={onClose} disabled={phase === 'saving'} aria-label="Закрыть"><IconClose size={16} /></button>
        </div>
        <div className="kpr-modal-body">
          {!inReview && (
            <>
              <p className="kpr-muted">
                Файл — как выгрузка этой вкладки кнопкой «Excel»: <b>№ п/п, Источник, Объект, Наименование, Ед. изм., Цена, Тендер,
                Дата расценки</b>. Колонки могут идти в другом порядке, обязательны наименование и цена. Объект узнаётся и по
                короткому названию («Зил33», «injoy», «18 19 27»), неузнанный выберете перед загрузкой. Ничего не запишется,
                пока не нажмёте «Загрузить»; такие же расценки, как уже есть в реестре, второй раз не попадут.
              </p>
              <div className={`kpr-drop${over ? ' is-over' : ''}`}>
                <input ref={fileRef} type="file" accept={REGISTRY_IMPORT_ACCEPT} hidden onChange={(e) => { pickFiles(e.target.files); e.target.value = '' }} />
                <button type="button" className="kpr-btn kpr-btn-primary" onClick={() => fileRef.current?.click()} disabled={busy || !ctx}>
                  <IconUpload size={16} /> Выбрать файл
                </button>
                <span className="kpr-muted">{ctx ? 'или перетащите сюда · Excel (.xlsx, .xls) или CSV' : 'Загружаем справочники объектов и тендеров…'}</span>
              </div>
              {phase === 'reading' && <p className="kpr-progress" role="status">Распознаём «{file?.name}»…</p>}
              {readError && <p className="kpr-error" role="alert"><IconAlert size={14} /> {file ? `«${file.name}»: ` : ''}{readError}</p>}
              {ctxError && <p className="kpr-error" role="alert"><IconAlert size={14} /> Справочники не загрузились: {ctxError}</p>}
              {!!ctx?.imports.length && (
                <div className="sri-imports">
                  <p className="sri-block-title">Загруженные файлы</p>
                  <table className="sri-imports-table">
                    <thead><tr><th>Файл</th><th>Когда</th><th>Кто</th><th className="kpr-money">Строк</th><th aria-label="Действия" /></tr></thead>
                    <tbody>
                      {ctx.imports.map((imp) => (
                        <tr key={imp.id}>
                          <td className="sri-file">{imp.file_name}</td>
                          <td>{fmtStamp(imp.created_at)}</td>
                          <td>{imp.created_by_name || '—'}</td>
                          <td className="kpr-money">{imp.rows == null ? '—' : fmtCount(imp.rows)}</td>
                          <td>
                            <button type="button" className="kpr-link-btn sri-danger" onClick={() => removeImport(imp)} disabled={busy}>
                              {deleting === imp.id ? 'Удаляем…' : 'Удалить'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {inReview && (
            <>
              <div className="kpr-summary">
                <span className="kpr-file-name"><PaperclipIcon size={14} /> {file.name}</span>
                <span className="kpr-muted">лист «{parsed.sheetName}» · строк: <b className="kpr-num">{fmtCount(prepared.counts.total)}</b></span>
                <button type="button" className="kpr-link-btn" onClick={() => { setPhase('pick'); setParsed(null) }} disabled={busy}>другой файл</button>
              </div>

              <div className="sri-block">
                <p className="sri-block-title">Объекты в файле</p>
                {onceInFile && (
                  <label className="sri-once">
                    <input type="checkbox" checked={primaveraOnce} disabled={busy} onChange={(e) => setPrimaveraOnce(e.target.checked)} />
                    {' '}«Primavera» без корпуса в этом файле — <b>{primaveraK14(index)?.name}</b>
                    <span className="kpr-muted"> (разово: после загрузки этот выбор больше не предлагается)</span>
                  </label>
                )}
                <table className="sri-objects">
                  <thead><tr><th>Как в файле</th><th className="kpr-money">Строк</th><th>Объект портала</th><th>Распознан</th></tr></thead>
                  <tbody>
                    {labels.map((l) => (
                      <ObjectRow key={l.label} entry={l} objects={objectsSorted} disabled={busy} onChoose={chooseObject} />
                    ))}
                  </tbody>
                </table>
              </div>

              {(hasEmptySource || hasEmptyDate) && (
                <div className="kpr-settings">
                  {hasEmptySource && (
                    <label className="sri-default">
                      Источник, где в файле пусто
                      <input type="text" value={defaults.source} maxLength={200} disabled={busy}
                        onChange={(e) => setDefaults((d) => ({ ...d, source: e.target.value }))} />
                    </label>
                  )}
                  {hasEmptyDate && (
                    <label className="sri-default">
                      Дата расценки, где в файле пусто
                      <input type="date" value={defaults.date} max={today} disabled={busy}
                        onChange={(e) => setDefaults((d) => ({ ...d, date: e.target.value }))} />
                    </label>
                  )}
                </div>
              )}

              <div className="kpr-filters" role="group" aria-label="Показать строки">
                {FILTERS.map(([k, label]) => {
                  const n = k === 'all' ? prepared.counts.total : prepared.counts[k]
                  if (k !== 'all' && !n) return null
                  return (
                    <button key={k} type="button" className={`kpr-filter${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                      {label}<span className="kpr-num">{fmtCount(n)}</span>
                    </button>
                  )
                })}
              </div>

              <div className="kpr-table-wrap">
                <table className="kpr-table sri-lines">
                  <thead>
                    <tr>
                      <th className="sri-c-row">Строка</th>
                      <th className="sri-c-src">Источник</th>
                      <th className="sri-c-obj">Объект</th>
                      <th>Наименование</th>
                      <th className="sri-c-unit">Ед. изм.</th>
                      <th className="sri-c-price kpr-money">Цена, ₽</th>
                      <th className="sri-c-tender">Тендер</th>
                      <th className="sri-c-date">Дата</th>
                      <th className="sri-c-status">Итог</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.slice(0, LINES_SHOWN).map((l) => (
                      <tr key={`${l.sheet}|${l.rowNo}`} className={`is-${l.status}`}>
                        <td className="kpr-muted">{l.rowNo}</td>
                        <td>{l.sourceName}</td>
                        <td>{l.objectId ? index.find((o) => o.id === l.objectId)?.name : <span className="kpr-muted">{l.object || '—'}</span>}</td>
                        <td className="kpr-line-name">{l.name || '—'}</td>
                        <td>{l.unit || '—'}</td>
                        <td className="kpr-money">{l.price != null ? fmtMoney(l.price) : (l.priceText || '—')}</td>
                        <td title={l.tender}>
                          {l.tenderId ? `№ ${l.tenderNumber ?? ''}` : <span className="kpr-muted">{l.tender || '—'}</span>}
                        </td>
                        <td>{l.day ? fmtDay(l.day) : (l.dateText || '—')}</td>
                        <td className={`sri-status is-${l.status}`}>{l.status === 'error' ? l.problem : STATUS_TEXT[l.status]}</td>
                      </tr>
                    ))}
                    {!shown.length && <tr><td colSpan={9} className="kpr-muted">Строк нет</td></tr>}
                  </tbody>
                </table>
              </div>
              {shown.length > LINES_SHOWN && (
                <p className="kpr-muted">Показаны первые {LINES_SHOWN} из {fmtCount(shown.length)} строк — загрузятся все строки «к загрузке».</p>
              )}
            </>
          )}
          {saveError && <p className="kpr-error" role="alert"><IconAlert size={14} /> {saveError}</p>}
        </div>
        <div className="kpr-modal-foot">
          {inReview && (
            <span className="kpr-foot-note sri-foot-note">
              Тендер в реестре — ссылкой, если найден однозначно (номер или описание на объекте строки), иначе текстом из файла.
            </span>
          )}
          {phase === 'saving' && progress && <span className="kpr-progress" role="status">Загружаем: {fmtCount(progress.done)} из {fmtCount(progress.total)}…</span>}
          <button type="button" className="kpr-btn" onClick={onClose} disabled={phase === 'saving'}>Закрыть</button>
          {inReview && (
            <button type="button" className="kpr-btn kpr-btn-primary" onClick={save} disabled={busy || !toImport.length}>
              {phase === 'saving' ? 'Загружаем…' : `Загрузить в реестр: ${fmtCount(toImport.length)}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// Название объекта из файла → объект портала: распознан сам, несколько похожих (подходящие — первыми) или не распознан.
function ObjectRow({ entry, objects, disabled, onChoose }) {
  const { label, count, resolution, objectId, auto, once } = entry
  const candidateIds = new Set(resolution.candidates.map((c) => c.id))
  const note = once && objectId === auto ? 'разово — см. отметку выше'
    : objectId && objectId === auto ? 'да'
      : objectId ? 'выбран вручную'
        : resolution.status === 'many' ? `несколько похожих (${resolution.candidates.length}) — выберите`
          : label ? 'нет — выберите' : 'в файле пусто — можно выбрать один на все строки'
  return (
    <tr className={objectId ? '' : 'is-open'}>
      <td className="sri-label">{label || <span className="kpr-muted">(пусто)</span>}</td>
      <td className="kpr-money">{fmtCount(count)}</td>
      <td>
        <select value={objectId} disabled={disabled} onChange={(e) => onChoose(label, e.target.value)} aria-label={`Объект портала для «${label || 'пусто'}»`}>
          <option value="">{label ? '— не выбран (как в файле) —' : '— без объекта —'}</option>
          {candidateIds.size > 0 && (
            <optgroup label="Подходящие">
              {objects.filter((o) => candidateIds.has(o.id)).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </optgroup>
          )}
          <optgroup label="Все объекты">
            {objects.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </optgroup>
        </select>
      </td>
      <td className={objectId ? 'kpr-muted' : 'sri-need'}>{note}</td>
    </tr>
  )
}
