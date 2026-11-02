import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { IconUpload } from '../icons/BsmIcons'
import { IconAlert, IconCheck, IconTrash } from '../icons/ActionIcons'
import PaperclipIcon from '../icons/PaperclipIcon'
import { formatAmount, roundMoney } from '../../utils/money'
import { autoPickRows, RULE_CHEAPEST, RULE_NEWEST } from '../../utils/supplyAutoPick'
import { DOC_READ_PROBLEM } from '../../utils/supplyDocPrice'

// За один раз — не больше (каждый файл читается и загружается по очереди).
const FILES_MAX = 20
const FILTERS = [['all', 'Все'], ['check', 'Проверить'], ['replace', 'Заменит свою цену'], ['none', 'Цены нет']]
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '')
const fmtVolume = (v) => (v == null ? '' : String(Math.round(Number(v) * 1000) / 1000).replace('.', ','))
const volumesOf = (group) => group.targets.map((t) => `${t.doc}: ${fmtVolume(t.position.volume)} ${t.position.unit || ''}`.trim()).join(' · ')
const totalOf = (group, price) => group.targets.reduce((s, t) => s + (Number(t.position.volume) > 0 ? price * Number(t.position.volume) : 0), 0)
const packText = (n) => String(Math.round(n * 1000000) / 1000000).replace('.', ',')

// Почему у позиции такая цена: то же наименование, артикул, выбрана при проверке, похожая; упаковка — с пересчётом.
function OfferTags({ offer, group }) {
  return (
    <>
      {offer.picked ? <span className="sp-di-tag is-exact">выбрано при проверке</span>
        : offer.exact ? <span className="sp-di-tag is-exact"><IconCheck size={12} /> то же наименование</span>
          : offer.article ? <span className="sp-di-tag is-exact">артикул совпал</span>
            : <span className="sp-di-tag">похоже на {Math.round(offer.score * 100)} %</span>}
      {offer.pack != null && <span className="sp-di-tag">1 {offer.line.unit} = {packText(offer.pack)} {group.unit}: {formatAmount(offer.line.price)} ₽ за {offer.line.unit}</span>}
      {!offer.unitOk && <span className="sp-di-tag is-warn">ед. изм.: в документе «{offer.line.unit}» — проверьте файл построчно</span>}
      {offer.line.sumOff && <span className="sp-di-tag is-warn">цена × кол-во ≠ сумма</span>}
      {offer.qtyFar && <span className="sp-di-tag is-warn">после пересчёта количество не похоже на объём ВОР</span>}
    </>
  )
}

const statusText = (status) => {
  if (!status) return <span className="sp-muted">—</span>
  if (status.kind === 'replace') return <span className="sp-di-tag is-warn">заменит {status.prices.slice(0, 2).map((p) => formatAmount(p)).join(', ')}</span>
  if (status.kind === 'copy') return <span>заменит цену из другого тендера</span>
  if (status.kind === 'new') return <span>нет цены</span>
  return <span className="sp-muted">та же цена</span>
}

// Строка автовыбора: отметка, позиция и её объёмы, выбранная цена, откуда она; остальные цены этой позиции — по «ещё N».
const PickRow = memo(function PickRow({ row, checked, busy, onCheck, onChoose }) {
  const [open, setOpen] = useState(false)
  const { group, choice, offers, spread, status } = row
  const others = offers.filter((o) => o !== choice)
  return (
    <tr className={[!choice && 'is-unmatched', checked && 'is-checked'].filter(Boolean).join(' ')}>
      <td className="sp-di-sel">
        <input type="checkbox" checked={checked} disabled={busy || !choice || status?.kind === 'same'} onChange={(e) => onCheck(group.key, e.target.checked)}
          aria-label={`Применить цену: ${group.name}`} />
      </td>
      <td className="sp-di-doc">
        <span className="sp-di-name">{group.name}</span>
        <span className="sp-di-meta sp-td-volumes">{volumesOf(group)}</span>
      </td>
      <td className="ui-money sp-di-price">
        {choice ? formatAmount(choice.price) : '—'}
        {choice && group.unit && <span className="sp-di-meta">за {group.unit}</span>}
      </td>
      <td className="sp-td-source">
        {choice ? (
          <>
            <span className="sp-di-file"><PaperclipIcon size={14} /> {choice.doc.file_name}</span>
            <span className="sp-di-meta">{choice.line.name}</span>
            <span className="sp-di-opt-meta sp-td-tags">
              <OfferTags offer={choice} group={group} />
              {spread && <span className="sp-di-tag is-warn">цены отличаются в {spread} раз — проверьте</span>}
            </span>
          </>
        ) : <span className="sp-muted">нет цены, которую можно взять как есть</span>}
        {others.length > 0 && (
          <button type="button" className="sp-link-btn sp-td-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'свернуть' : `${choice ? 'ещё цены' : 'цены'}: ${others.length}`}
          </button>
        )}
        {open && (
          <div className="sp-di-choice" role="radiogroup" aria-label={`Цены для «${group.name}»`}>
            {offers.map((o) => (
              <label key={o.id} className={`sp-di-opt${o === choice ? ' is-on' : ''}`}>
                <input type="radio" name={`sp-td-${group.key}`} checked={o === choice} disabled={busy || !o.unitOk} onChange={() => onChoose(group.key, o.id)} />
                <span className="sp-di-opt-name ui-num">{formatAmount(o.price)} ₽ — {o.doc.file_name}</span>
                <span className="sp-di-opt-meta">
                  <span>{o.line.name}</span>
                  {o.date && <span className="ui-num">{fmtDay(o.date)}</span>}
                  <OfferTags offer={o} group={group} />
                </span>
              </label>
            ))}
          </div>
        )}
      </td>
      <td className="sp-di-now">{statusText(status)}</td>
    </tr>
  )
})

// Счета и КП тендера: файлы прикрепляют ко всему тендеру (один или несколько сразу, кнопкой или перетаскиванием), расценка
// сама читает их и подбирает каждой позиции ВОР цену (utils/supplyAutoPick): человек смотрит выбор и применяет одним
// нажатием — цены пишутся в расценку как ввод руками, файл становится документом позиции. Своя другая цена заменяется
// только по отметке. Файл, который не читается (скан, Word, фото), остаётся у тендера с понятной причиной.
// docs — [{ doc, offer }]; others — [{ doc, failed }] (не прочитан; failed null — читается); byGroup — цены по позициям
// (utils/supplyAutoPick.offersByGroup); groups — позиции ВОР; rates — чтобы пересчитать «сейчас в расценке» после записи;
// initialFiles — файлы, брошенные на таблицу. onAddFile(file) — прочитать и загрузить (ошибка — исключением);
// onDeleteDoc(doc); onReview(doc) — окно проверки файла построчно ({ reason } — не открылось); onOpenFile(doc) — просмотр;
// onApply(lines, onProgress) — записать [{ group, price, doc }], ответ { error } оставляет окно открытым.
export default function SupplyTenderDocsDialog({
  docs, others, byGroup, groups, rates, filesOn, currentOf, initialFiles = null, onAddFile, onDeleteDoc, onReview, onOpenFile, onApply, onClose,
}) {
  const [uploads, setUploads] = useState([]) // [{ id, name, status: reading | failed | duplicate, error }]
  const [rule, setRule] = useState(RULE_CHEAPEST)
  const [chosen, setChosen] = useState(() => new Map()) // ключ группы → id цены, выбранной человеком
  const [unticked, setUnticked] = useState(() => new Set())
  const [ticked, setTicked] = useState(() => new Set())
  const [filter, setFilter] = useState('all')
  const [applying, setApplying] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [reviewing, setReviewing] = useState(null)
  const fileRef = useRef(null)
  const uploading = uploads.some((u) => u.status === 'reading')
  const busy = applying || uploading

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  // ── Файлы ─────────────────────────────────────────────────────────────────────────────────────────
  const known = useRef(null)
  known.current = [...docs.map((x) => x.doc), ...others.map((x) => x.doc)]
  const nextId = useRef(0)
  const addFiles = async (fileList) => {
    const list = [...(fileList || [])]
    if (!list.length) return
    setError(list.length > FILES_MAX ? `За один раз — не больше ${FILES_MAX} файлов: остальные добавьте следующим заходом.` : '')
    for (const file of list.slice(0, FILES_MAX)) {
      const id = ++nextId.current
      // Тот же файл второй раз (то же имя и размер) — не загружаем: его цены уже есть и считались бы дважды.
      if (known.current.some((d) => d.file_name === file.name && Number(d.size_bytes) === file.size)) {
        setUploads((prev) => [...prev, { id, name: file.name, status: 'duplicate' }])
        continue
      }
      setUploads((prev) => [...prev, { id, name: file.name, status: 'reading' }])
      try {
        await onAddFile(file)
        setUploads((prev) => prev.filter((u) => u.id !== id))
      } catch (e) {
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, status: 'failed', error: e.message || 'ошибка загрузки' } : u)))
      }
    }
  }
  // Файлы, брошенные на таблицу: окно открылось уже с ними.
  const initialDone = useRef(false)
  useEffect(() => {
    if (initialDone.current || !initialFiles?.length) return
    initialDone.current = true
    addFiles(initialFiles)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только при открытии окна
  }, [])
  const review = async (doc) => {
    setError('')
    setReviewing(doc.id)
    try {
      const res = await onReview(doc)
      if (res?.reason) setError(`«${doc.file_name}»: ${DOC_READ_PROBLEM[res.reason] || DOC_READ_PROBLEM.unavailable}`)
    } finally {
      setReviewing(null)
    }
  }

  // ── Автовыбор ─────────────────────────────────────────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rates: currentOf читает цены из ссылки, пересчёт — при их смене
  const { rows, withoutOffers } = useMemo(() => autoPickRows(byGroup, groups, { rule, chosen, currentOf }), [byGroup, groups, rule, chosen, currentOf, rates])
  const isChecked = (r) => !!r.choice && r.status?.kind !== 'same' && (ticked.has(r.group.key) || (r.auto && !unticked.has(r.group.key)))
  const toApply = rows.filter(isChecked)
  const targetsCount = toApply.reduce((s, r) => s + r.group.targets.length, 0)
  const sum = toApply.reduce((s, r) => s + totalOf(r.group, r.choice.price), 0)
  const needsCheck = (r) => !r.choice || !r.sure || !!r.spread || !r.choice.unitOk
  const counts = {
    all: rows.length, check: rows.filter(needsCheck).length, replace: rows.filter((r) => r.status?.kind === 'replace').length, none: withoutOffers.length,
  }
  const shown = filter === 'check' ? rows.filter(needsCheck) : filter === 'replace' ? rows.filter((r) => r.status?.kind === 'replace') : filter === 'none' ? [] : rows
  const matchedOf = useMemo(() => {
    const m = new Map()
    for (const list of byGroup.values()) for (const o of list) m.set(o.doc.id, (m.get(o.doc.id) || 0) + 1)
    return m
  }, [byGroup])
  const onCheck = (key, on) => {
    setTicked((prev) => { const s = new Set(prev); if (on) s.add(key); else s.delete(key); return s })
    setUnticked((prev) => { const s = new Set(prev); if (on) s.delete(key); else s.add(key); return s })
  }
  const onChoose = (key, id) => setChosen((prev) => new Map(prev).set(key, id))

  const apply = async () => {
    if (!toApply.length) return
    setError('')
    setApplying(true)
    setProgress({ done: 0, total: targetsCount })
    try {
      const res = await onApply(toApply.map((r) => ({ group: r.group, price: r.choice.price, doc: r.choice.doc })), (done, total) => setProgress({ done, total }))
      if (res?.error) setError(res.error)
    } catch (e) {
      setError(e.message || 'Цены не записаны')
    } finally {
      setApplying(false)
    }
  }

  const withFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
  const drop = {
    onDragOver: (e) => { if (withFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = applying ? 'none' : 'copy'; setDragOver(!applying) } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) },
    onDrop: (e) => {
      if (!withFiles(e)) return
      e.preventDefault()
      setDragOver(false)
      if (!applying) addFiles(e.dataTransfer.files)
    },
  }

  return (
    <div className="sp-modal-backdrop sp-modal-backdrop-full" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className={`sp-modal sp-modal-docimport is-full${dragOver ? ' is-drop' : ''}`} role="dialog" aria-modal="true" aria-labelledby="sp-td-title" {...drop}>
        <h3 id="sp-td-title">Счета и КП тендера</h3>
        <div className="sp-modal-body">
          <div className={`sp-drop sp-td-drop${dragOver ? ' is-over' : ''}`}>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
            <button type="button" className="btn-primary" onClick={() => fileRef.current?.click()} disabled={applying}>
              <IconUpload size={16} /> Выбрать файлы
            </button>
            <span className="sp-muted">
              или перетащите сюда — один или несколько. Excel и PDF с текстом читаются сами, цены подберутся к позициям ВОР.
              {!filesOn && ' Файлы к тендеру не сохраняются: на сервере не применено обновление базы.'}
            </span>
          </div>

          {(docs.length > 0 || others.length > 0 || uploads.length > 0) && (
            <ul className="sp-doc-list sp-td-files" aria-label="Файлы тендера">
              {uploads.map((u) => (
                <li key={`u${u.id}`}>
                  <span className="sp-di-file"><PaperclipIcon size={14} /> {u.name}</span>
                  <span className={`sp-td-state${u.status === 'failed' ? ' sp-error-text' : ''}`} role="status">
                    {u.status === 'reading' && 'читаем и загружаем…'}
                    {u.status === 'duplicate' && 'этот файл уже есть у тендера — второй раз не загружаем'}
                    {u.status === 'failed' && <><IconAlert size={14} /> не загрузился: {u.error}</>}
                  </span>
                </li>
              ))}
              {docs.map(({ doc, offer }) => (
                <li key={doc.id}>
                  <button type="button" className="sp-link-btn sp-di-file" onClick={() => onOpenFile(doc)} title="Открыть файл"><PaperclipIcon size={14} /> {doc.file_name}</button>
                  <span className="sp-td-state">
                    {offer.date ? `${fmtDay(offer.date)} · ` : ''}строк с ценой: <b className="ui-num">{offer.lines.length}</b> · нашли позиции: <b className="ui-num">{matchedOf.get(doc.id) || 0}</b>
                    {offer.total && !offer.total.ok && (
                      <span className="sp-di-tag is-warn">итог в документе {formatAmount(offer.total.doc)} ₽, в строках {formatAmount(offer.total.read)} ₽ — проверьте</span>
                    )}
                    {offer.currency && <span className="sp-di-tag is-warn">цены в {offer.currency} — укажите курс при проверке</span>}
                  </span>
                  <span className="sp-td-actions">
                    <button type="button" className="sp-link-btn" onClick={() => review(doc)} disabled={busy || reviewing === doc.id}
                      aria-label={`Проверить построчно: ${doc.file_name}`}>{reviewing === doc.id ? 'открываем…' : 'проверить построчно'}</button>
                    <button type="button" className="sp-icon-btn" onClick={() => onDeleteDoc(doc)} disabled={busy}
                      aria-label={`Удалить файл «${doc.file_name}»`} title="Удалить файл — пропадёт у всех позиций, где он документ"><IconTrash size={16} /></button>
                  </span>
                </li>
              ))}
              {others.map(({ doc, failed }) => (
                <li key={doc.id}>
                  <button type="button" className="sp-link-btn sp-di-file" onClick={() => onOpenFile(doc)} title="Открыть файл"><PaperclipIcon size={14} /> {doc.file_name}</button>
                  <span className="sp-td-state">{failed ? DOC_READ_PROBLEM[failed] || DOC_READ_PROBLEM.broken : 'читаем…'}</span>
                  <span className="sp-td-actions">
                    <button type="button" className="sp-icon-btn" onClick={() => onDeleteDoc(doc)} disabled={busy}
                      aria-label={`Удалить файл «${doc.file_name}»`} title="Удалить файл — пропадёт у всех позиций, где он документ"><IconTrash size={16} /></button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {(rows.length > 0 || withoutOffers.length > 0) && docs.length > 0 && (
            <>
              <div className="sp-di-filters">
                <div className="sp-filter" role="group" aria-label="Показать позиции">
                  {FILTERS.map(([k, label]) => (
                    <button key={k} type="button" className={`sp-filter-btn${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label} ({counts[k]})</button>
                  ))}
                </div>
                <fieldset className="sp-td-rule" disabled={applying}>
                  <legend className="ui-sr-only">Какую цену выбирать</legend>
                  <span className="sp-muted">Из нескольких цен брать:</span>
                  <label><input type="radio" name="sp-td-rule" checked={rule === RULE_CHEAPEST} onChange={() => { setRule(RULE_CHEAPEST); setChosen(new Map()) }} /> самую низкую</label>
                  <label><input type="radio" name="sp-td-rule" checked={rule === RULE_NEWEST} onChange={() => { setRule(RULE_NEWEST); setChosen(new Map()) }} /> из самого свежего документа</label>
                </fieldset>
              </div>
              {filter === 'none' ? (
                <ul className="sp-td-none" aria-label="Позиции без цены в документах">
                  {withoutOffers.map((g) => <li key={g.key}>{g.name} <span className="sp-muted">{volumesOf(g)}</span></li>)}
                  {!withoutOffers.length && <li className="sp-muted">Цены есть у всех позиций.</li>}
                </ul>
              ) : (
                <div className="table-container sp-di-wrap">
                  <table className="data-table sp-di-table sp-td-table">
                    <colgroup>
                      <col className="sp-di-c-sel" /><col className="sp-td-c-pos" /><col className="sp-di-c-price" /><col className="sp-td-c-source" /><col className="sp-di-c-now" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th><span className="ui-sr-only">Применить</span></th>
                        <th>Позиция ВОР</th>
                        <th className="ui-money">Цена, ₽</th>
                        <th>Откуда</th>
                        <th>Сейчас в расценке</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <PickRow key={r.group.key} row={r} checked={isChecked(r)} busy={applying} onCheck={onCheck} onChoose={onChoose} />
                      ))}
                      {!shown.length && <tr><td colSpan={5} className="no-data">Строк нет</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {error && <p className="sp-error-text" role="alert">{error}</p>}
        </div>
        <div className="sp-modal-actions sp-di-actions">
          <span className="sp-di-attach sp-td-sum" aria-live="polite">
            {toApply.length > 0 && <>Итого по выбранным: <b className="ui-num">{formatAmount(roundMoney(sum))} ₽</b>. Файл станет документом позиции.</>}
          </span>
          {applying && progress && <span className="sp-di-progress" role="status">Сохраняем цены: {progress.done} из {progress.total}…</span>}
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Закрыть</button>
          <button type="button" className="btn-primary" onClick={apply} disabled={busy || !toApply.length}>
            {applying ? 'Применяем…' : `Применить цены: ${toApply.length}${targetsCount > toApply.length ? ` (позиций ВОР: ${targetsCount})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
