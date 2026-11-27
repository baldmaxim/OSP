import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconUpload } from '../icons/BsmIcons'
import { IconAlert, IconCheck, IconEyeOff } from '../icons/ActionIcons'
import { IconSearch } from '../icons/ToolbarIcons'
import PaperclipIcon from '../icons/PaperclipIcon'
import { formatAmount, roundMoney } from '../../utils/money'
import { PICK_BLOCKS, autoPickRows, groupHideKeys, hideKeysByDoc, isHiddenAt, unplacedLines, windowOffers } from '../../utils/supplyAutoPick'
import { scanProgressText } from '../../utils/supplyOffers'
import Name from './SupplyNameDiff'
import SupplyTenderFilesDialog, { filesAttention } from './SupplyTenderFilesDialog'
import SupplyUnplacedDialog from './SupplyUnplacedDialog'

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

// Откуда цена, которую заменит строка (utils/supplyAutoPick.replacedBy): подставлена из другого тендера — каким; из документа —
// каким (этот же документ — значит, у него сменили НДС или пересчёт); введена вручную — как.
const tenderOf = (o) => (o?.tender_number ? `тендера № ${o.tender_number}${o.price_date ? ` от ${fmtDay(o.price_date)}` : ''}` : 'другого тендера')
function nowSource(x, row) {
  if (x.kind === 'auto') return `подставлена сама из ${tenderOf(x.origin)}`
  if (x.kind === 'doc') {
    if (row.sameDoc) return 'из этого же документа — до смены НДС или пересчёта'
    return `из «${x.offer.doc.file_name}»${x.offer.date ? ` от ${fmtDay(x.offer.date)}` : ''}`
  }
  if (x.how === 'pick') return `взята вручную из ${tenderOf(x.origin)}`
  if (x.how === 'import') return 'загружена из Excel'
  return 'введена вручную'
}
function NowCell({ row }) {
  const items = row.replaced.filter((x) => x.kind !== 'empty')
  if (!items.length) return <span className="sp-muted">нет цены</span>
  const prices = [...new Set(items.map((x) => roundMoney(x.price)))]
  const main = items.find((x) => x.kind === row.block) || items[0]
  return (
    <span className={`sp-td-now is-${row.block}`}>
      <span className="ui-num">{prices.slice(0, 2).map((p) => formatAmount(p)).join(', ')}</span>
      <span className="sp-td-meta" title={main.origin?.object_name || undefined}>{nowSource(main, row)}</span>
      {row.wrong && <span className="sp-td-meta is-warn">похоже на ошибку</span>}
    </span>
  )
}

// Шапка блока: галочка «все в блоке» (строки с неподходящей ед. изм. не отмечаются), название, сколько строк и отмечено.
const BLOCK_HINT = {
  auto: 'цены других тендеров, которые расценка поставила сама',
  manual: 'сами не отмечаются: цена, введённая вручную, важнее документа',
}
function BlockHead({ block, rows, isChecked, busy, onAll }) {
  const ref = useRef(null)
  const checkable = rows.filter((r) => r.shown.unitOk)
  const on = checkable.filter(isChecked).length
  const all = checkable.length > 0 && on === checkable.length
  useEffect(() => { if (ref.current) ref.current.indeterminate = on > 0 && !all }, [on, all])
  return (
    <tr className={`sp-td-group is-${block.key}`}>
      <td className="sp-td-sel">
        <input ref={ref} type="checkbox" checked={all} disabled={busy || !checkable.length} onChange={(e) => onAll(checkable, e.target.checked)}
          aria-label={`Отметить все: ${block.title}`} title={all ? 'Снять все в блоке' : 'Отметить все в блоке'} />
      </td>
      <td colSpan={4}>
        <span className="sp-td-block-title">{block.title}</span>
        <span className="sp-td-block-count ui-num">{rows.length}</span>
        {on > 0 && <span className="sp-td-block-on">отмечено {on}</span>}
        {BLOCK_HINT[block.key] && <span className="sp-td-block-hint">{BLOCK_HINT[block.key]}</span>}
      </td>
    </tr>
  )
}

// Строка: отметка; позиция ВОР (полужирным) и под ней строка счёта — двумя блоками одной ячейки; единицы, цена, что сейчас в расценке.
// 27.11.2026 (просьба пользователя): наименования — не рядом в двух колонках, а одно над другим, каждое со своей подписью слева
// («ВОР», «В счёте»), строка счёта — на своей подложке; строки окна разделены просветом. Подсветка отличий — как была.
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
      <td className="sp-td-cmp">
        <div className="sp-td-pos">
          <span className="sp-td-side">ВОР</span>
          <div className="sp-td-body">
            <Name text={group.name} other={shown.line.name} strong />
            {volume != null && <span className="sp-td-meta ui-num" title={volumesTitle(group)}>{fmtNum(volume)} {group.unit || ''}{group.targets.length > 1 ? ` · ${group.targets.length} ВОР` : ''}</span>}
          </div>
        </div>
        <div className="sp-td-line">
          <span className="sp-td-side">В счёте</span>
          <div className="sp-td-body">
            <Name text={shown.line.name} other={group.name} />
            <span className="sp-td-meta">
              <button type="button" className="sp-td-file" onClick={() => onOpenFile(shown.doc)} title="Открыть файл"><PaperclipIcon size={12} /> {shown.doc.file_name}{shown.date ? ` · ${fmtDay(shown.date)}` : ''}</button>
              <button type="button" className="sp-link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>другая строка</button>
            </span>
            {!sure && <span className="sp-td-tag">похоже на {Math.round(shown.score * 100)} %</span>}
            {spread && <span className="sp-td-tag is-warn">цены в счетах отличаются в {spread} раз</span>}
            {shown.line.sumOff && <span className="sp-td-tag is-warn">цена × кол-во ≠ сумма</span>}
            {shown.line.unsure && !shown.line.sumOff && (shown.ocr
              ? <span className="sp-td-tag is-warn" title="Строка со скана, а суммы для сверки в ней нет: цифры могли распознаться неверно.">со скана: сверьте с файлом</span>
              : <span className="sp-td-tag is-warn" title="В ячейке документа несколько позиций одна под другой: наименование могло разделиться неверно.">сверьте с файлом</span>)}
            {shown.qtyFar && <span className="sp-td-tag is-warn">после пересчёта количество не похоже на объём</span>}
            {shown.over && <span className="sp-td-tag is-warn" title="Цена строки больше итога всего документа: строка прочитана неверно (например, склеились две цены).">цена больше итога документа</span>}
            {!shown.over && shown.docOk === false && <span className="sp-td-tag is-warn" title="Сумма прочитанных строк не сошлась с итогом документа: часть строк могла прочитаться неверно. Сами такие цены не отмечаются.">итог документа не сошёлся — сверьте</span>}
            {shown.twins?.length > 0 && <span className="sp-td-meta" title={shown.twins.map((d) => d.file_name).join('\n')}>та же цена и в {shown.twins.length === 1 ? `«${shown.twins[0].file_name}»` : `${shown.twins.length} документах`}</span>}
            {open && <LinePicker row={row} allLines={allLines} busy={busy} onPick={(d, l) => onPick(group, d, l, shown)} onReject={(d, l) => onReject(group, d, l)} onClose={() => setOpen(false)} />}
          </div>
        </div>
      </td>
      <td><UnitCell offer={shown} group={group} busy={busy} onPack={(o, n) => onPack(group, o.doc, o.line, n)} /></td>
      <td className="ui-money sp-td-price">{formatAmount(shown.price)}</td>
      <td><NowCell row={row} /></td>
    </tr>
  )
})

// Счета и КП тендера: закинули файлы (кнопкой или перетаскиванием в окно) — расценка сама читает их и подбирает позициям цены:
// самую похожую строку, а если та же позиция есть в нескольких документах — из самого свежего (utils/supplyAutoPick). Человек
// сравнивает позицию ВОР и строку счёта, единицы и применяет одной кнопкой: цены пишутся как ввод руками, файл становится документом
// позиции. Цена уже стоит правильно — такой строки нет. Скан и фото распознаются прямо в браузере (секунды на страницу, ход виден), их
// цифры сверяются между собой; файл, который не читается (Word, плохой скан), остаётся у тендера с понятной причиной.
// docs — [{ doc, offer }]; others — [{ doc, failed, progress }] (не прочитан; failed null — читается); byGroup — цены по позициям
// (offersByGroup); groups — позиции; rates — чтобы пересчитать «сейчас в расценке» после записи; initialFiles — файлы, которые уже
// выбрали (бросили на таблицу, прикрепили к позиции), attachTo — позиции, к которым они прикрепляются.
// onAddFile(file, attachTo) — прочитать и загрузить (ошибка — исключением); onAttachDoc(doc, attachTo) — файл уже есть у тендера;
// onDeleteDoc(doc); onOpenFile(doc) — просмотр; onApply(lines, onProgress) — записать [{ group, price, doc }], ответ { error }
// оставляет окно открытым. Выбор человека — при файле (и в следующий раз): onPickLine(group, doc, line), onRejectLine(group, doc,
// line), onPack(group, doc, line, n), onSetRate(doc, rate) — курс, если цены не в рублях, onSetVat(doc, mode).
//
// 13.11.2026 (просьба пользователя: «разом убрать позиции, которые я не захотел расценивать, и чтобы они не мешались с ценами нового
// документа — вносить раздельно»): слева над таблицей — «Убрать неотмеченные»: позиции без галочки уходят из окна, у документов,
// чьи цены они показывали (onHide(Map id документа → ключи позиций), при файле; «вернуть» — onUnhide(Set id документов)). Новый
// документ предлагает эти позиции заново. Цены — по документам: «Цены из» — все документы или один; файл, загруженный в окне, сразу
// показывается один — его цены не смешиваются с прежними, автовыбор идёт только среди его строк. Галочка в шапке — отметить или
// снять все строки разом. onAddFile отвечает загруженным файлом.
//
// 18.11.2026 (просьба пользователя): строки — блоками по тому, что заменит цена (utils/supplyAutoPick.PICK_BLOCKS): не расценены;
// подставленные автоматически (видно, из какого тендера); цены из документов (из какого; этот же документ — после смены НДС);
// введённые вручную — последними и без отметки: ручная цена важнее. У каждого блока слева галочка «все в блоке». Один и тот же
// документ, загруженный дважды, — в списке файлов пометкой «повтор» (dupes — [{ doc, of }]), его цены не повторяются.
// 19.11.2026 (просьба пользователя: «когда убираю счёт, как снять цены, которые из него проставлялись»): onDeleteDoc открывает окно
// удаления (файл один или вместе с его ценами) и отвечает { note }; removed — удалённые файлы, чьи цены ещё стоят
// ([{ docId, name, at, rows }], utils/supplyDocPrices.removedDocPrices): строка «удалён …» в списке файлов — «снять цены»
// (onClearRemoved) или «оставить» (onKeepRemoved); оба отвечают текстом для строки состояния.
// 24.11.2026 (просьба пользователя): плашки файлов над таблицей заменены кнопкой «Документы» — все файлы, их состояние, скачать по
// одному и все (SupplyTenderFilesDialog); здесь остались только загружаемые сейчас (ход чтения, отказ, повтор). На кнопке — сколько
// файлов и, отдельной пометкой, что ждёт действия: курс валюты, удалённые файлы с ценами. archiveOwner — начало имени архива.
// 27.11.2026 (просьба пользователя): «Строки счетов без позиции ВОР» — не раскрывающийся блок внизу, а кнопка в шапке рядом с
// «Документами» (подсвечена, пока такие строки есть) и своё большое окно (SupplyUnplacedDialog): похожие позиции одной кнопкой, поиск,
// после выбора окно не закрывается.
export default function SupplyTenderDocsDialog({
  docs, dupes = [], others, byGroup, groups, rates, filesOn, currentOf, initialFiles = null, attachTo = null, onAddFile, onAttachDoc, onDeleteDoc, onOpenFile, onApply, onClose,
  onPickLine, onRejectLine, onPack, onSetRate, onSetVat, onHide, onUnhide, removed = [], onClearRemoved, onKeepRemoved, archiveOwner = 'Тендер',
}) {
  const [uploads, setUploads] = useState([]) // [{ id, name, status: reading | failed | duplicate, error }]
  const [chosen, setChosen] = useState(() => new Map()) // ключ группы → id цены, выбранной человеком
  const [unticked, setUnticked] = useState(() => new Set())
  const [ticked, setTicked] = useState(() => new Set())
  const [applying, setApplying] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [hiding, setHiding] = useState(false)
  // Чьи цены в окне: null — всех документов, иначе Set id. Загруженные в окне — fresh: окно сразу показывает их одних.
  const [view, setView] = useState(null)
  const [fresh, setFresh] = useState(() => new Set())
  const fileRef = useRef(null)
  const headBoxRef = useRef(null)
  const [removing, setRemoving] = useState(false) // снимаем или оставляем цены удалённого файла
  const [filesOpen, setFilesOpen] = useState(false) // окно «Документы тендера»
  const [unplacedOpen, setUnplacedOpen] = useState(false) // окно «Строки счетов без позиции ВОР»
  const uploading = uploads.some((u) => u.status === 'reading')
  const busy = applying || uploading || hiding || removing

  // Escape: открыто окно документов или строк без позиции — закрывает только его; открыт просмотр файла — только просмотр (он закрывается сам). Окно
  // удаления файла ловит Escape раньше (на погружении) и дальше его не пускает. Был ли просмотр — смотрим на погружении: к нашему
  // обработчику он уже закрылся (его обработчик — на document, раньше window), и Escape закрыл бы заодно и окно.
  // Подписка — один раз, состояние — из ссылки: закрытый просмотр перерисовывает страницу посреди того же нажатия, и переподписанный
  // обработчик не знал бы, что просмотр был.
  const escState = useRef(null)
  escState.current = { busy, filesOpen, unplacedOpen, onClose }
  useEffect(() => {
    let covered = false
    const onCapture = (e) => { if (e.key === 'Escape') covered = !!document.querySelector('.s3-doc-preview-overlay') }
    const onKey = (e) => {
      if (e.key !== 'Escape' || covered) return
      const { busy: working, filesOpen: inFiles, unplacedOpen: inUnplaced, onClose: close } = escState.current
      if (inFiles) setFilesOpen(false)
      else if (inUnplaced) setUnplacedOpen(false)
      else if (!working) close()
    }
    window.addEventListener('keydown', onCapture, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onCapture, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // Удаление файла — в своём окне (SupplyDocDeleteDialog): с ценами, поставленными из него, или без; итог — строкой здесь.
  const deleteDoc = (doc) => Promise.resolve(onDeleteDoc(doc)).then((res) => { if (res?.note) { setError(''); setNote(res.note) } })
  // Удалённые файлы, чьи цены ещё стоят (19.11.2026): снять цены или оставить их обычными ценами.
  const removedAct = async (act, entry) => {
    setError('')
    setRemoving(true)
    try {
      const text = await act(entry)
      if (text) setNote(text)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setRemoving(false)
    }
  }

  // ── Файлы ─────────────────────────────────────────────────────────────────────────────────────────
  const known = useRef(null)
  known.current = [...docs.map((x) => x.doc), ...dupes.map((x) => x.doc), ...others.map((x) => x.doc)]
  const nextId = useRef(0)
  const addFiles = async (fileList, attach = null) => {
    const list = [...(fileList || [])]
    if (!list.length) return
    setError(list.length > FILES_MAX ? `За один раз — не больше ${FILES_MAX} файлов: остальные добавьте следующим заходом.` : '')
    const added = []
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
        const doc = await onAddFile(file, attach, ({ page, pages }) => setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, progress: scanProgressText(page, pages) } : u))))
        if (doc?.id != null) added.push(doc.id)
        setUploads((prev) => prev.filter((u) => u.id !== id))
      } catch (e) {
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, status: 'failed', error: e.message || 'ошибка загрузки' } : u)))
      }
    }
    // Новые документы — отдельно от прежних: окно показывает цены только из них (переключается в «Цены из»).
    if (added.length) {
      setFresh((prev) => new Set([...prev, ...added]))
      setView(new Set(added))
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
  // Выбранные документы, у которых есть строки с ценами; ни одного (файл не прочитался, удалён) — все документы.
  const viewIds = view && docs.some((x) => view.has(x.doc.id)) ? view : null
  const viewDocs = useMemo(() => (viewIds ? docs.filter((x) => viewIds.has(x.doc.id)) : docs), [docs, viewIds])
  const shownOffers = useMemo(() => windowOffers(byGroup, docs, viewIds), [byGroup, docs, viewIds])
  // Пока цены записываются, строки окна не пересчитываются на каждой записанной цене: окно закроется, когда запишутся все.
  const ratesSeen = useRef(rates)
  if (!applying) ratesSeen.current = rates
  const ratesNow = ratesSeen.current
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rates: currentOf читает цены из ссылки, пересчёт — при их смене
  const { rows, held } = useMemo(() => autoPickRows(shownOffers.byGroup, groups, { chosen, currentOf, allByGroup: byGroup }), [shownOffers, groups, chosen, currentOf, ratesNow, byGroup])
  const isChecked = (r) => r.shown.unitOk && (ticked.has(r.group.key) || (r.auto && !unticked.has(r.group.key)))
  const toApply = rows.filter(isChecked)
  // Неотмеченные — и строки блока «введённые вручную» (сами не отмечаются): убрать их — оставить ручные цены как есть.
  const unchecked = rows.filter((r) => !isChecked(r))
  const checkable = rows.filter((r) => r.shown.unitOk)
  const sum = toApply.reduce((s, r) => s + totalOf(r.group, r.shown.price), 0)
  const blocks = PICK_BLOCKS.map((block) => ({ block, rows: rows.filter((r) => r.block === block.key) })).filter((b) => b.rows.length)
  const unplaced = useMemo(() => unplacedLines(viewDocs, byGroup), [viewDocs, byGroup])
  const allLines = useMemo(() => viewDocs.filter((x) => !x.offer.currency).flatMap(({ doc, offer }) => offer.lines.filter((l) => !l.skip).map((line) => ({ doc, line }))), [viewDocs])
  const onCheck = useCallback((key, on) => {
    setTicked((prev) => { const s = new Set(prev); if (on) s.add(key); else s.delete(key); return s })
    setUnticked((prev) => { const s = new Set(prev); if (on) s.delete(key); else s.add(key); return s })
  }, [])
  // Галочка в шапке: отметить или снять все строки окна (строки с неподходящей ед. изм. не отмечаются).
  const allOn = checkable.length > 0 && checkable.every(isChecked)
  const someOn = toApply.length > 0 && !allOn
  useEffect(() => { if (headBoxRef.current) headBoxRef.current.indeterminate = someOn }, [someOn])
  const checkAll = (on, list = checkable) => {
    const keys = list.map((r) => r.group.key)
    setTicked((prev) => { const s = new Set(prev); for (const k of keys) { if (on) s.add(k); else s.delete(k) } return s })
    setUnticked((prev) => { const s = new Set(prev); for (const k of keys) { if (on) s.delete(k); else s.add(k) } return s })
  }
  // Убрать неотмеченные — при файлах; вернуть — убранное у документов окна.
  const hideUnchecked = async () => {
    if (!unchecked.length || busy) return
    setError('')
    setHiding(true)
    try {
      await onHide(hideKeysByDoc(unchecked))
    } catch (e) {
      setError(`Позиции не убрались: ${e.message || e}`)
    } finally {
      setHiding(false)
    }
  }
  const unhide = async () => {
    if (busy) return
    setError('')
    setHiding(true)
    try {
      await onUnhide(new Set(viewDocs.map((x) => x.doc.id)))
    } catch (e) {
      setError(`Убранное не вернулось: ${e.message || e}`)
    } finally {
      setHiding(false)
    }
  }
  const viewValue = !viewIds ? 'all' : fresh.size > 1 && viewIds.size === fresh.size && [...fresh].every((id) => viewIds.has(id)) ? 'fresh'
    : viewIds.size === 1 ? String([...viewIds][0]) : 'all'
  const changeView = (value) => {
    if (value === 'all') setView(null)
    else if (value === 'fresh') setView(new Set(fresh))
    else {
      const x = docs.find((d) => String(d.doc.id) === value)
      setView(x ? new Set([x.doc.id]) : null)
    }
  }
  // Выбор человека — сразу в этой строке и при файле: строка помнится и при следующем открытии.
  const pickLine = (group, doc, line, replaced = null) => {
    setChosen((prev) => new Map(prev).set(group.key, `${doc.id}:${line.name}:${group.key}`))
    onCheck(group.key, true)
    // Прежняя строка этой позиции больше не предлагается: иначе при следующем открытии она вернулась бы, если её документ свежее.
    const swapped = replaced && replaced.line !== line ? onRejectLine(group, replaced.doc, replaced.line) : null
    // Строку выбрали сами, а позиция у её документа убрана из окна — вернуть: иначе выбор не был бы виден.
    const shown = isHiddenAt(docs, doc.id, group) ? onHide(new Map([[doc.id, new Set(groupHideKeys(group))]]), { show: true }) : null
    Promise.all([swapped, shown, onPickLine(group, doc, line)]).catch((e) => setError(`Выбор не сохранился: ${e.message}`))
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
  // Обработчики строк — одни и те же между отрисовками (вызывают последние версии): иначе каждая отрисовка окна (ход записи цен,
  // отметка строки) перерисовывала все строки таблицы — memo у PickRow не срабатывал.
  const latest = useRef(null)
  latest.current = { pickLine, rejectLine, setPack, onOpenFile }
  const onPickRow = useCallback((...a) => latest.current.pickLine(...a), [])
  const onRejectRow = useCallback((...a) => latest.current.rejectLine(...a), [])
  const onPackRow = useCallback((...a) => latest.current.setPack(...a), [])
  const onOpenRowFile = useCallback((doc) => latest.current.onOpenFile(doc), [])
  const rowProps = { busy: applying || hiding, allLines, onCheck, onPick: onPickRow, onReject: onRejectRow, onPack: onPackRow, onOpenFile: onOpenRowFile }
  const fileCount = docs.length + dupes.length + others.length
  const attention = filesAttention(docs, removed)
  const setVat = (doc, mode) => Promise.resolve(onSetVat(doc, mode))
    .then(() => setNote(`НДС в «${doc.file_name}» изменён: где его цены уже стоят, новые — в блоке «Заменят цены из документов», отмечены.`))
    .catch((err) => setError(err.message))
  const setRate = (doc, n) => Promise.resolve(onSetRate(doc, n)).catch((err) => setError(err.message))
  const noFiles = !docs.length && !dupes.length && !others.length && !uploads.length && !removed.length
  const showTools = rows.length > 0 || shownOffers.hidden > 0 || docs.length > 1

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
          {(fileCount > 0 || removed.length > 0) && (
            <button type="button" className={`btn-secondary sp-td-files-btn${attention ? ' is-warn' : ''}`} onClick={() => setFilesOpen(true)} aria-haspopup="dialog"
              aria-label={`Документы тендера: ${fileCount}${attention ? `, ждут действия: ${attention}` : ''}`}
              title={attention ? 'Все файлы тендера. Есть что сделать: курс валюты или цены удалённого файла' : 'Все файлы тендера: открыть, скачать, удалить'}>
              <PaperclipIcon size={16} /> Документы <span className="ui-num">{fileCount}</span>
              {attention > 0 && <span className="sp-td-files-attn ui-num" aria-hidden="true"><IconAlert size={12} />{attention}</span>}
            </button>
          )}
          {(unplaced.length > 0 || unplacedOpen) && (
            <button type="button" className={`btn-secondary sp-td-files-btn sp-td-unplaced-btn${unplaced.length ? ' is-attn' : ''}`} onClick={() => setUnplacedOpen(true)} aria-haspopup="dialog"
              aria-label={`Строки счетов без позиции ВОР: ${unplaced.length}`}
              title="Строки счетов и КП, которым алгоритм не нашёл позицию ВОР: сопоставить вручную">
              <IconAlert size={15} /> Без позиции ВОР <span className="ui-num">{unplaced.length}</span>
            </button>
          )}
          {!filesOn && <span className="sp-muted">Файлы к тендеру не сохраняются: на сервере не применено обновление базы.</span>}
        </div>
        <div className="sp-modal-body">
          {uploads.length > 0 && (
            <ul className="sp-td-uploads" aria-label="Загружаемые файлы">
              {uploads.map((u) => (
                <li key={`u${u.id}`} className={u.status === 'failed' ? 'is-off' : undefined} role="status">
                  <PaperclipIcon size={12} /> {u.name}
                  <span className="sp-td-meta">
                    {u.status === 'reading' && (u.progress || 'читаем…')}
                    {u.status === 'duplicate' && 'уже есть у тендера'}
                    {u.status === 'failed' && <><IconAlert size={12} /> не загрузился: {u.error}</>}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {noFiles && <p className="sp-td-empty">Закиньте счёт или КП — Excel, PDF, скан или фото. Цены подберутся к позициям ВОР сами, останется сравнить и применить.</p>}
          {showTools && (
            <div className="sp-td-tools">
              {rows.length > 0 && (
                <button type="button" className="btn-secondary sp-td-hide" onClick={hideUnchecked} disabled={busy || !unchecked.length}
                  title="Позиции без галочки уйдут из окна: цены этих документов им больше не предлагаются. Новый документ предложит их заново.">
                  <IconEyeOff size={15} /> {hiding ? 'Убираем…' : `Убрать неотмеченные: ${unchecked.length}`}
                </button>
              )}
              {docs.length > 1 && (
                <label className="sp-td-view">
                  <span>Цены из</span>
                  <select value={viewValue} disabled={busy} onChange={(e) => changeView(e.target.value)} aria-label="Цены каких документов показывать">
                    <option value="all">всех документов ({docs.length})</option>
                    {fresh.size > 1 && <option value="fresh">загруженных сейчас ({fresh.size})</option>}
                    {docs.map(({ doc, offer }) => (
                      <option key={doc.id} value={String(doc.id)}>
                        {fresh.has(doc.id) ? 'новый: ' : ''}{doc.file_name}{offer.date || doc.created_at ? ` · ${fmtDay(offer.date || doc.created_at)}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {shownOffers.hidden > 0 && (
                <span className="sp-td-hidden sp-muted">
                  Убрано позиций: {shownOffers.hidden}
                  <button type="button" className="sp-link-btn" onClick={unhide} disabled={busy}>вернуть</button>
                </span>
              )}
            </div>
          )}
          {/* Строки, похожие на позиции с другой ценой не наверняка (autoPickRows.held), окно не показывает — но и не говорит, что цены стоят. */}
          {!noFiles && !rows.length && !uploading && docs.length > 0 && (held > 0
            ? <p className="sp-td-empty" role="status">Новых цен нет: у позиций, на которые похожи строки документа ({held}), уже стоит другая цена, а это не та же позиция наверняка — нет того же артикула или наименования. Взять такую цену можно в таблице: «цены поставщиков» у позиции.</p>
            : <p className="sp-td-empty" role="status"><IconCheck size={16} /> {shownOffers.hidden > 0 || viewIds
              ? 'Ставить больше нечего: цены этих документов уже стоят или позиции убраны.'
              : 'Все цены из документов уже стоят в расценке.'}</p>
          )}

          {rows.length > 0 && (
            <div className="table-container sp-td-wrap">
              <table className="data-table sp-td-table">
                <colgroup>
                  <col className="sp-td-c-sel" /><col /><col className="sp-td-c-unit" /><col className="sp-td-c-price" /><col className="sp-td-c-now" />
                </colgroup>
                <thead>
                  <tr>
                    <th className="sp-td-sel">
                      <input ref={headBoxRef} type="checkbox" checked={allOn} disabled={busy || !checkable.length}
                        onChange={(e) => checkAll(e.target.checked)} aria-label="Отметить все строки" title={allOn ? 'Снять все' : 'Отметить все'} />
                    </th>
                    <th>Позиция ВОР и строка счёта</th>
                    <th>Ед. изм.</th>
                    <th className="ui-money">Цена, ₽</th>
                    <th>Сейчас в расценке</th>
                  </tr>
                </thead>
                {blocks.map(({ block, rows: list }) => (
                  <tbody key={block.key} className={`sp-td-block is-${block.key}`}>
                    <BlockHead block={block} rows={list} isChecked={isChecked} busy={applying || hiding} onAll={(items, on) => checkAll(on, items)} />
                    {list.map((r) => <PickRow key={r.group.key} row={r} checked={isChecked(r)} {...rowProps} />)}
                  </tbody>
                ))}
              </table>
            </div>
          )}

          {/* Окно документов открыто — строка состояния в нём (оно закрывает эту). */}
          {note && !error && !filesOpen && <p className="sp-td-note" role="status">{note}</p>}
          {error && !filesOpen && <p className="sp-error-text" role="alert">{error}</p>}
        </div>
        {unplacedOpen && (
          <SupplyUnplacedDialog items={unplaced} groups={groups} busy={applying || hiding} onPick={onPickRow} onUndo={onRejectRow}
            onOpenFile={onOpenRowFile} onClose={() => setUnplacedOpen(false)} />
        )}
        {filesOpen && (
          <SupplyTenderFilesDialog docs={docs} dupes={dupes} others={others} removed={removed} busy={busy} archiveOwner={archiveOwner}
            note={note} error={error} onOpenFile={onOpenFile} onDelete={deleteDoc} onSetRate={setRate} onSetVat={setVat}
            onClearRemoved={(entry) => removedAct(onClearRemoved, entry)} onKeepRemoved={(entry) => removedAct(onKeepRemoved, entry)}
            onClose={() => setFilesOpen(false)} />
        )}
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
