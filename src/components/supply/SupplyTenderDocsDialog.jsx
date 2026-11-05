import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { IconUpload } from '../icons/BsmIcons'
import { IconAlert, IconCheck, IconTrash } from '../icons/ActionIcons'
import { IconSearch } from '../icons/ToolbarIcons'
import PaperclipIcon from '../icons/PaperclipIcon'
import { formatAmount, roundMoney } from '../../utils/money'
import { autoPickRows, unplacedLines } from '../../utils/supplyAutoPick'
import { searchGroups } from '../../utils/supplyDocMatch'
import { DOC_READ_PROBLEM } from '../../utils/supplyDocPrice'
import { nameDiff } from '../../utils/supplyNameDiff'
import { offerVatMode } from '../../utils/supplyOffers'

// За один раз — не больше (каждый файл читается и загружается по очереди).
const FILES_MAX = 20
const PICK_LIMIT = 8
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '')
const fmtNum = (v) => String(Math.round(Number(v) * 1000) / 1000).replace('.', ',')
const totalOf = (group, price) => group.targets.reduce((s, t) => s + (Number(t.position.volume) > 0 ? price * Number(t.position.volume) : 0), 0)
const volumesTitle = (group) => group.targets.map((t) => `${t.doc}: ${fmtNum(t.position.volume ?? 0)} ${t.position.unit || ''}`.trim()).join('\n')
const positive = (v) => {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}
// Объём позиции во всех её ВОР.
function totalVolume(group) {
  if (group.units) return null
  const list = group.targets.map((t) => t.position.volume).filter((v) => v != null)
  return list.length ? list.reduce((s, v) => s + Number(v), 0) : null
}

// Наименование с подсвеченными отличиями от другой стороны.
function Name({ text, other, strong = false }) {
  const parts = useMemo(() => nameDiff(text, other), [text, other])
  const Tag = strong ? 'b' : 'span'
  return <Tag className="sp-td-name">{parts.map((p, i) => (p.differs ? <mark key={i} className="sp-td-diff">{p.text}</mark> : <span key={i}>{p.text}</span>))}</Tag>
}

// Единицы: совпадают — галочка; пересчитаны — как; разные и пересчёт неизвестен — указать, сколько в единице счёта.
function UnitCell({ offer, group, busy, onPack }) {
  const [value, setValue] = useState('')
  const unit = group.unit || (group.units || []).join(', ') || '—'
  const lineUnit = offer.line.unit
  if (!offer.unitOk) {
    return (
      <span className="sp-td-unit is-off" title={`В ВОР — ${unit}, в счёте — ${lineUnit}`}>
        <span>{lineUnit} ≠ {unit}</span>
        {group.unit && (
          <span className="sp-td-pack">
            1 {lineUnit} =
            <input type="text" inputMode="decimal" className="sp-td-num" value={value} disabled={busy} onChange={(e) => setValue(e.target.value)}
              onBlur={() => { const n = positive(value); if (n) onPack(offer, n) }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              aria-label={`Сколько ${unit} в 1 ${lineUnit}: ${group.name}`} />
            {unit}
          </span>
        )}
      </span>
    )
  }
  if (offer.pack != null) {
    return <span className="sp-td-unit is-pack" title={`В счёте цена ${formatAmount(offer.line.price)} ₽ за ${lineUnit}`}>{lineUnit} → {unit}<span className="sp-td-meta">1 {lineUnit} = {fmtNum(offer.pack)} {unit}</span></span>
  }
  if (!lineUnit) return <span className="sp-td-unit sp-muted" title="В счёте ед. изм. не указана">{unit}</span>
  return <span className="sp-td-unit is-ok" title={`Ед. изм. совпадают: в ВОР — ${unit}, в счёте — ${lineUnit}`}><IconCheck size={14} /> {unit}</span>
}

// Другая строка счёта для позиции: самые похожие, поиск по всем строкам всех документов; «нет в счетах» — эту больше не предлагать.
function LinePicker({ row, allLines, busy, onPick, onReject, onClose }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const options = q
    ? allLines.filter((x) => q.split(/\s+/).every((w) => x.line.name.toLowerCase().includes(w))).slice(0, PICK_LIMIT)
    : row.offers.slice(0, PICK_LIMIT)
  return (
    <div className="sp-td-picker">
      <label className="ui-search sp-td-find">
        <IconSearch size={14} />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти в счетах" disabled={busy}
          aria-label={`Найти строку счёта для «${row.group.name}»`}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); if (query) setQuery(''); else onClose() } }} />
      </label>
      <ul>
        {options.map((o) => {
          const on = o.line === row.shown.line && o.doc.id === row.shown.doc.id
          return (
            <li key={`${o.doc.id}:${o.line.name}`} className={on ? 'is-on' : undefined}>
              <button type="button" className="sp-td-opt" disabled={busy} aria-pressed={on} onClick={() => { onPick(o.doc, o.line); onClose() }}>
                <span>{o.line.name}</span>
                <span className="sp-td-meta ui-num">{formatAmount(o.price ?? o.line.price)} ₽ · {o.doc.file_name}{o.score != null && !on && o.score < 1 ? ` · похоже на ${Math.round(o.score * 100)} %` : ''}</span>
              </button>
            </li>
          )
        })}
        {!options.length && <li className="sp-muted">Ничего не нашли</li>}
      </ul>
      <button type="button" className="sp-link-btn" disabled={busy} onClick={() => { onReject(row.shown.doc, row.shown.line); onClose() }}>нет в счетах — не предлагать эту строку</button>
    </div>
  )
}

// Что сейчас в расценке: пусто, цена другого тендера, своя другая цена (заменится).
function NowCell({ row }) {
  const { status, wrong } = row
  if (status.kind === 'replace') {
    return (
      <span className="sp-td-now is-replace">
        <span className="ui-num">{status.prices.slice(0, 2).map((p) => formatAmount(p)).join(', ')}</span>
        {wrong && <span className="sp-td-meta">похоже на ошибку</span>}
      </span>
    )
  }
  if (status.kind === 'copy') return <span className="sp-td-now"><span className="sp-td-meta">цена другого тендера</span></span>
  return <span className="sp-muted">—</span>
}

// Строка: отметка, позиция ВОР (полужирным) и строка счёта рядом, единицы, цена, что сейчас в расценке.
const PickRow = memo(function PickRow({ row, checked, busy, allLines, onCheck, onPick, onReject, onPack, onOpenFile }) {
  const [open, setOpen] = useState(false)
  const { group, shown, sure, spread } = row
  const volume = totalVolume(group)
  return (
    <tr className={checked ? 'is-checked' : undefined}>
      <td className="sp-td-sel">
        <input type="checkbox" checked={checked} disabled={busy || !shown.unitOk} onChange={(e) => onCheck(group.key, e.target.checked)}
          aria-label={`Применить цену: ${group.name}`} />
      </td>
      <td className="sp-td-pos">
        <Name text={group.name} other={shown.line.name} strong />
        {volume != null && <span className="sp-td-meta ui-num" title={volumesTitle(group)}>{fmtNum(volume)} {group.unit || ''}{group.targets.length > 1 ? ` · ${group.targets.length} ВОР` : ''}</span>}
      </td>
      <td className="sp-td-line">
        <Name text={shown.line.name} other={group.name} />
        <span className="sp-td-meta">
          <button type="button" className="sp-td-file" onClick={() => onOpenFile(shown.doc)} title="Открыть файл"><PaperclipIcon size={12} /> {shown.doc.file_name}{shown.date ? ` · ${fmtDay(shown.date)}` : ''}</button>
          <button type="button" className="sp-link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>другая строка</button>
        </span>
        {!sure && <span className="sp-td-tag">похоже на {Math.round(shown.score * 100)} %</span>}
        {spread && <span className="sp-td-tag is-warn">цены в счетах отличаются в {spread} раз</span>}
        {shown.line.sumOff && <span className="sp-td-tag is-warn">цена × кол-во ≠ сумма</span>}
        {shown.qtyFar && <span className="sp-td-tag is-warn">после пересчёта количество не похоже на объём</span>}
        {open && <LinePicker row={row} allLines={allLines} busy={busy} onPick={(d, l) => onPick(group, d, l, shown)} onReject={(d, l) => onReject(group, d, l)} onClose={() => setOpen(false)} />}
      </td>
      <td><UnitCell offer={shown} group={group} busy={busy} onPack={(o, n) => onPack(group, o.doc, o.line, n)} /></td>
      <td className="ui-money sp-td-price">{formatAmount(shown.price)}</td>
      <td><NowCell row={row} /></td>
    </tr>
  )
})

// Строка счёта без позиции ВОР: указать позицию поиском.
function UnplacedLine({ item, groups, busy, onPick }) {
  const [query, setQuery] = useState('')
  const found = useMemo(() => (query.trim() ? searchGroups(query, groups, PICK_LIMIT) : []), [query, groups])
  const { doc, line } = item
  return (
    <li>
      <span className="sp-td-unplaced-name">{line.name}<span className="sp-td-meta ui-num">{formatAmount(line.price)} ₽{line.unit ? ` за ${line.unit}` : ''} · {doc.file_name}</span></span>
      <span className="sp-td-unplaced-find">
        <label className="ui-search sp-td-find">
          <IconSearch size={14} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти позицию ВОР" disabled={busy} aria-label={`Найти позицию ВОР для «${line.name}»`} />
        </label>
        {found.length > 0 && (
          <ul className="sp-td-picker-list">
            {found.map((g) => (
              <li key={g.key}><button type="button" className="sp-td-opt" disabled={busy} onClick={() => { onPick(g, doc, line); setQuery('') }}>{g.name}{g.unit ? <span className="sp-td-meta">{g.unit}</span> : null}</button></li>
            ))}
          </ul>
        )}
      </span>
    </li>
  )
}

// Счета и КП тендера: закинули файлы (кнопкой или перетаскиванием в окно) — расценка сама читает их и подбирает позициям цены:
// самую похожую строку, а если та же позиция есть в нескольких документах — из самого свежего (utils/supplyAutoPick). Человек
// сравнивает позицию ВОР и строку счёта, единицы и применяет одной кнопкой: цены пишутся как ввод руками, файл становится документом
// позиции. Цена уже стоит правильно — такой строки нет. Файл, который не читается (скан, Word, фото), остаётся у тендера с понятной
// причиной. docs — [{ doc, offer }]; others — [{ doc, failed }] (не прочитан; failed null — читается); byGroup — цены по позициям
// (offersByGroup); groups — позиции; rates — чтобы пересчитать «сейчас в расценке» после записи; initialFiles — файлы, которые уже
// выбрали (бросили на таблицу, прикрепили к позиции), attachTo — позиции, к которым они прикрепляются.
// onAddFile(file, attachTo) — прочитать и загрузить (ошибка — исключением); onAttachDoc(doc, attachTo) — файл уже есть у тендера;
// onDeleteDoc(doc); onOpenFile(doc) — просмотр; onApply(lines, onProgress) — записать [{ group, price, doc }], ответ { error }
// оставляет окно открытым. Выбор человека — при файле (и в следующий раз): onPickLine(group, doc, line), onRejectLine(group, doc,
// line), onPack(group, doc, line, n), onSetRate(doc, rate) — курс, если цены не в рублях, onSetVat(doc, mode).
export default function SupplyTenderDocsDialog({
  docs, others, byGroup, groups, rates, filesOn, currentOf, initialFiles = null, attachTo = null, onAddFile, onAttachDoc, onDeleteDoc, onOpenFile, onApply, onClose,
  onPickLine, onRejectLine, onPack, onSetRate, onSetVat,
}) {
  const [uploads, setUploads] = useState([]) // [{ id, name, status: reading | failed | duplicate, error }]
  const [chosen, setChosen] = useState(() => new Map()) // ключ группы → id цены, выбранной человеком
  const [unticked, setUnticked] = useState(() => new Set())
  const [ticked, setTicked] = useState(() => new Set())
  const [applying, setApplying] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState(false)
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
  const addFiles = async (fileList, attach = null) => {
    const list = [...(fileList || [])]
    if (!list.length) return
    setError(list.length > FILES_MAX ? `За один раз — не больше ${FILES_MAX} файлов: остальные добавьте следующим заходом.` : '')
    for (const file of list.slice(0, FILES_MAX)) {
      const id = ++nextId.current
      // Тот же файл второй раз (то же имя и размер) — не загружаем: его цены уже есть и считались бы дважды.
      const same = known.current.find((d) => d.file_name === file.name && Number(d.size_bytes) === file.size)
      if (same) {
        if (attach) onAttachDoc?.(same, attach)
        else setUploads((prev) => [...prev, { id, name: file.name, status: 'duplicate' }])
        continue
      }
      setUploads((prev) => [...prev, { id, name: file.name, status: 'reading' }])
      try {
        await onAddFile(file, attach)
        setUploads((prev) => prev.filter((u) => u.id !== id))
      } catch (e) {
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, status: 'failed', error: e.message || 'ошибка загрузки' } : u)))
      }
    }
  }
  // Файлы, уже выбранные до окна: окно открылось с ними.
  const initialDone = useRef(false)
  useEffect(() => {
    if (initialDone.current || !initialFiles?.length) return
    initialDone.current = true
    addFiles(initialFiles, attachTo)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только при открытии окна
  }, [])

  // ── Автовыбор ─────────────────────────────────────────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rates: currentOf читает цены из ссылки, пересчёт — при их смене
  const { rows } = useMemo(() => autoPickRows(byGroup, groups, { chosen, currentOf }), [byGroup, groups, chosen, currentOf, rates])
  const isChecked = (r) => r.shown.unitOk && (ticked.has(r.group.key) || (r.auto && !unticked.has(r.group.key)))
  const toApply = rows.filter(isChecked)
  const sum = toApply.reduce((s, r) => s + totalOf(r.group, r.shown.price), 0)
  const checkRows = rows.filter((r) => r.check)
  const sureRows = rows.filter((r) => !r.check)
  const unplaced = useMemo(() => unplacedLines(docs, byGroup), [docs, byGroup])
  const allLines = useMemo(() => docs.filter((x) => !x.offer.currency).flatMap(({ doc, offer }) => offer.lines.filter((l) => !l.skip).map((line) => ({ doc, line }))), [docs])
  const onCheck = (key, on) => {
    setTicked((prev) => { const s = new Set(prev); if (on) s.add(key); else s.delete(key); return s })
    setUnticked((prev) => { const s = new Set(prev); if (on) s.delete(key); else s.add(key); return s })
  }
  // Выбор человека — сразу в этой строке и при файле: строка помнится и при следующем открытии.
  const pickLine = (group, doc, line, replaced = null) => {
    setChosen((prev) => new Map(prev).set(group.key, `${doc.id}:${line.name}:${group.key}`))
    onCheck(group.key, true)
    // Прежняя строка этой позиции больше не предлагается: иначе при следующем открытии она вернулась бы, если её документ свежее.
    const swapped = replaced && replaced.line !== line ? onRejectLine(group, replaced.doc, replaced.line) : null
    Promise.all([swapped, onPickLine(group, doc, line)]).catch((e) => setError(`Выбор не сохранился: ${e.message}`))
  }
  const rejectLine = (group, doc, line) => {
    setChosen((prev) => { const m = new Map(prev); m.delete(group.key); return m })
    Promise.resolve(onRejectLine(group, doc, line)).catch((e) => setError(`Выбор не сохранился: ${e.message}`))
  }
  const setPack = (group, doc, line, n) => {
    onCheck(group.key, true)
    Promise.resolve(onPack(group, doc, line, n)).catch((e) => setError(`Пересчёт не сохранился: ${e.message}`))
  }

  const apply = async () => {
    if (!toApply.length) return
    setError('')
    setApplying(true)
    setProgress({ done: 0, total: toApply.length })
    try {
      const res = await onApply(toApply.map((r) => ({ group: r.group, price: r.shown.price, doc: r.shown.doc })), (done, total) => setProgress({ done, total }))
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
  const rowProps = { busy: applying, allLines, onCheck, onPick: pickLine, onReject: rejectLine, onPack: setPack, onOpenFile }
  const noFiles = !docs.length && !others.length && !uploads.length

  return (
    <div className="sp-modal-backdrop sp-modal-backdrop-full" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className={`sp-modal sp-modal-full${dragOver ? ' is-drop' : ''}`} role="dialog" aria-modal="true" aria-labelledby="sp-td-title" {...drop}>
        <div className="sp-td-head">
          <h3 id="sp-td-title">Счета и КП тендера</h3>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
          <button type="button" className="btn-primary" onClick={() => fileRef.current?.click()} disabled={applying}>
            <IconUpload size={16} /> Выбрать файлы
          </button>
          <span className="sp-muted">или перетащите в это окно</span>
          {!filesOn && <span className="sp-muted">Файлы к тендеру не сохраняются: на сервере не применено обновление базы.</span>}
        </div>
        <div className="sp-modal-body">
          {!noFiles && (
            <ul className="sp-td-files" aria-label="Файлы тендера">
              {uploads.map((u) => (
                <li key={`u${u.id}`} className={u.status === 'failed' ? 'is-off' : undefined} role="status">
                  <PaperclipIcon size={12} /> {u.name}
                  <span className="sp-td-meta">
                    {u.status === 'reading' && 'читаем…'}
                    {u.status === 'duplicate' && 'уже есть у тендера'}
                    {u.status === 'failed' && <><IconAlert size={12} /> не загрузился: {u.error}</>}
                  </span>
                </li>
              ))}
              {docs.map(({ doc, offer }) => {
                const vat = offerVatMode(offer)
                return (
                  <li key={doc.id}>
                    <button type="button" className="sp-td-file" onClick={() => onOpenFile(doc)} title="Открыть файл"><PaperclipIcon size={12} /> {doc.file_name}</button>
                    {(offer.date || doc.created_at) && <span className="sp-td-meta ui-num">{fmtDay(offer.date || doc.created_at)}</span>}
                    {offer.currency ? (
                      <span className="sp-td-pack is-warn">
                        цены в {offer.currency}, курс ₽:
                        <input type="text" inputMode="decimal" className="sp-td-num" disabled={busy} aria-label={`Курс, ₽ за 1 ${offer.currency}: ${doc.file_name}`}
                          onBlur={(e) => { const n = positive(e.target.value); if (n) Promise.resolve(onSetRate(doc, n)).catch((err) => setError(err.message)) }}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
                      </span>
                    ) : (
                      <select className="sp-td-vat" value={vat} disabled={busy} aria-label={`НДС в ценах: ${doc.file_name}`} title="Какие цены в документе. Цена в расценке — с НДС."
                        onChange={(e) => Promise.resolve(onSetVat(doc, e.target.value)).catch((err) => setError(err.message))}>
                        <option value="gross">с НДС</option>
                        <option value="net">без НДС, +{offer.vat?.rate ?? 22} %</option>
                      </select>
                    )}
                    {offer.total && !offer.total.ok && (
                      <span className="sp-td-tag is-warn" title={`Итог в документе ${formatAmount(offer.total.doc)} ₽, в прочитанных строках ${formatAmount(offer.total.read)} ₽: часть строк могла не прочитаться, или в документе скидка на весь заказ.`}>итог не сходится</span>
                    )}
                    <button type="button" className="sp-icon-btn sp-td-del" onClick={() => onDeleteDoc(doc)} disabled={busy}
                      aria-label={`Удалить файл «${doc.file_name}»`} title="Удалить файл — пропадёт у всех позиций, где он документ"><IconTrash size={14} /></button>
                  </li>
                )
              })}
              {others.map(({ doc, failed }) => (
                <li key={doc.id} className={failed ? 'is-off' : undefined}>
                  <button type="button" className="sp-td-file" onClick={() => onOpenFile(doc)} title="Открыть файл"><PaperclipIcon size={12} /> {doc.file_name}</button>
                  <span className="sp-td-meta">{failed ? DOC_READ_PROBLEM[failed] || DOC_READ_PROBLEM.broken : 'читаем…'}</span>
                  <button type="button" className="sp-icon-btn sp-td-del" onClick={() => onDeleteDoc(doc)} disabled={busy}
                    aria-label={`Удалить файл «${doc.file_name}»`} title="Удалить файл — пропадёт у всех позиций, где он документ"><IconTrash size={14} /></button>
                </li>
              ))}
            </ul>
          )}

          {noFiles && <p className="sp-td-empty">Закиньте счёт или КП — Excel или PDF с текстом. Цены подберутся к позициям ВОР сами, останется сравнить и применить.</p>}
          {!noFiles && !rows.length && !uploading && docs.length > 0 && (
            <p className="sp-td-empty" role="status"><IconCheck size={16} /> Все цены из документов уже стоят в расценке.</p>
          )}

          {rows.length > 0 && (
            <div className="table-container sp-td-wrap">
              <table className="data-table sp-td-table">
                <colgroup>
                  <col className="sp-td-c-sel" /><col /><col /><col className="sp-td-c-unit" /><col className="sp-td-c-price" /><col className="sp-td-c-now" />
                </colgroup>
                <thead>
                  <tr>
                    <th><span className="ui-sr-only">Применить</span></th>
                    <th>Позиция ВОР</th>
                    <th>В счёте</th>
                    <th>Ед. изм.</th>
                    <th className="ui-money">Цена, ₽</th>
                    <th>Сейчас</th>
                  </tr>
                </thead>
                {checkRows.length > 0 && (
                  <tbody>
                    {sureRows.length > 0 && <tr className="sp-td-group"><td colSpan={6}>Проверьте: {checkRows.length}</td></tr>}
                    {checkRows.map((r) => <PickRow key={r.group.key} row={r} checked={isChecked(r)} {...rowProps} />)}
                  </tbody>
                )}
                {sureRows.length > 0 && (
                  <tbody>
                    {checkRows.length > 0 && <tr className="sp-td-group"><td colSpan={6}>Та же позиция: {sureRows.length}</td></tr>}
                    {sureRows.map((r) => <PickRow key={r.group.key} row={r} checked={isChecked(r)} {...rowProps} />)}
                  </tbody>
                )}
              </table>
            </div>
          )}

          {unplaced.length > 0 && (
            <details className="sp-td-unplaced">
              <summary>Строки счетов без позиции ВОР: {unplaced.length}</summary>
              <ul>
                {unplaced.map((u) => <UnplacedLine key={`${u.doc.id}:${u.line.name}`} item={u} groups={groups} busy={applying} onPick={pickLine} />)}
              </ul>
            </details>
          )}
          {error && <p className="sp-error-text" role="alert">{error}</p>}
        </div>
        <div className="sp-modal-actions sp-td-actions">
          <span className="sp-td-sum" aria-live="polite">
            {applying && progress ? `Сохраняем цены: ${progress.done} из ${progress.total}…`
              : toApply.length > 0 ? <>Итого по выбранным: <b className="ui-num">{formatAmount(roundMoney(sum))} ₽</b></> : null}
          </span>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Закрыть</button>
          <button type="button" className="btn-primary" onClick={apply} disabled={busy || !toApply.length}>
            {applying ? 'Применяем…' : `Применить цены: ${toApply.length}`}
          </button>
        </div>
      </div>
    </div>
  )
}
