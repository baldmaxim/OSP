import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconUpload } from '../icons/BsmIcons'
import { IconAlert, IconCheck } from '../icons/ActionIcons'
import { IconSearch } from '../icons/ToolbarIcons'
import PaperclipIcon from '../icons/PaperclipIcon'
import { formatAmount, roundMoney } from '../../utils/money'
import { DEFAULT_VAT_RATE, unitPriceWithVat } from '../../utils/supplierDoc'
import { SUPPLIER_DOC_ACCEPT, isPdfFile, isSheetFile, readSupplierDoc } from '../../utils/supplierDocRead'
import { deliveryFactor, groupUnitOk, matchDocItems, searchGroups } from '../../utils/supplyDocMatch'
import { offerNotes } from '../../utils/supplyOffers'

// Больше — не распознаём (страница подвисла бы на разборе); прикрепить такой файл можно в колонке «Документ».
const PARSE_MAX_BYTES = 30 * 1024 * 1024
// Сколько позиций ВОР видно у строки документа сразу (остальные кандидаты — «ещё N», любые — поиском).
const VISIBLE_OPTIONS = 4
const SEARCH_LIMIT = 12
// Сразу несколько файлов — не больше (каждый распознаётся по очереди).
const BATCH_MAX = 10

const READ_ERROR = {
  unsupported: () => 'Распознаются только Excel (.xlsx, .xls, .csv) и PDF.',
  broken: (r, name) => `Файл не читается как ${isPdfFile(name) ? 'PDF' : 'книга Excel'}${r.message ? ` (${r.message})` : ''}. Откройте его и сохраните заново: Excel — как .xlsx, PDF — «Печать в PDF».`,
  encrypted: () => 'PDF защищён паролем — снимите защиту или попросите у поставщика файл без пароля.',
  scan: () => 'В PDF нет текста — это скан или фото, распознать цены нечем. Попросите у поставщика Excel или PDF, выгруженный из 1С или Excel. Сам файл можно прикрепить к позициям вручную — в колонке «Документ».',
  no_table: () => 'Не нашли таблицу с ценами: нужна шапка с колонками «Наименование» (или «Товар») и «Цена» (или «Сумма»).',
  empty: () => 'Таблица найдена, но строк с ценой в ней нет.',
  big: () => `Файл больше ${PARSE_MAX_BYTES / 1024 / 1024} МБ — такой не распознаём. Прикрепить его можно в колонке «Документ».`,
}

const pct = (s) => `${Math.round(s * 100)} %`
const VAT_TEXT = { gross: 'цены с НДС', net: 'цены без НДС — НДС добавится', none: 'НДС не облагается — цены как есть' }
const unitText = (g) => g.unit || (g.units || []).join(', ') || '—'
const docPriceOf = (item) => item.price ?? (item.sum != null && item.qty > 0 ? item.sum / item.qty : null)
const docVatOf = (item) => (item.price != null ? item.priceVat : item.sumVat) || null

// Файл → распознанный документ { kind, pages | sheetName, items, vat, matches } или { error } (текст для человека).
async function readFile(f, groups) {
  if (!isPdfFile(f.name) && !isSheetFile(f.name)) return { error: READ_ERROR.unsupported() }
  if (f.size > PARSE_MAX_BYTES) return { error: READ_ERROR.big() }
  try {
    const r = await readSupplierDoc(new Uint8Array(await f.arrayBuffer()), f.name)
    if (r.error) return { error: (READ_ERROR[r.error] || READ_ERROR.broken)(r, f.name) }
    // Доставка — не позиция ВОР: не сопоставляется (и не забирает позицию у строки с материалом).
    const goodsMatches = matchDocItems(r.items.filter((it) => !it.delivery), groups)
    let k = 0
    const matches = r.items.map((item) => (item.delivery ? { item, match: null, candidates: [] } : goodsMatches[k++]))
    return { ...r, matches }
  } catch (e) {
    return { error: READ_ERROR.broken({ message: e.message }, f.name) }
  }
}

// Строки распознанного документа «в похожие цены» как есть — НДС как в документе, доставка — к ценам (сразу
// несколько файлов, без окна сопоставления): позиции расценка найдёт сама.
function batchNotes(r) {
  const priceOf = (it) => unitPriceWithVat(it, r.vat)
  const { factor } = deliveryFactor(r.items, priceOf)
  const lines = r.items.filter((it) => !it.delivery).map((it) => {
    const base = priceOf(it)
    return { name: it.name, unit: it.unit, qty: it.qty, code: it.code, price: base != null && base > 0 ? roundMoney(base * factor) : null, docPrice: docPriceOf(it), docVat: docVatOf(it) }
  })
  return { notes: offerNotes({ source: r.kind, vat: r.vat, delivery: factor, lines }), lines: lines.filter((l) => l.price != null).length }
}

// Распознавание счёта / КП / УПД поставщика (Excel или PDF): строки документа сопоставляются с позициями ВОР тендера
// (точно — по наименованию, иначе — по похожести: слова и числа, текст целиком, артикул), человек проверяет — у
// каждой строки «не сопоставлять» и сразу под ним самые похожие позиции, поиск по всем, — выбирает, считать ли цены с
// НДС и разносить ли доставку, и либо применяет (цены пишутся в расценку, как ввод руками, файл — документом к
// позициям, получившим цену), либо добавляет документ «в похожие цены» (цены не пишутся: у позиций — «цены
// поставщиков», выбирает человек в таблице). Несколько файлов сразу — без проверки, только «в похожие цены».
// groups — позиции ВОР, сложенные в одинаковые (utils/supplyDocMatch.positionGroups). currentOf(group) — что сейчас
// в расценке: { own: [цены], copies, empty }. onApply({ lines, file, attach, notes }, onProgress) — записать; ответ
// { error } оставляет окно открытым. onAddOffers(file, notes) — загрузить файл «в похожие цены» (ошибка — исключением);
// onOffersDone({ files, lines }) — все добавлены (панель закрывает окно и пишет, что сделано).
export default function SupplyDocImportDialog({ groups, currentOf, filesOn, onApply, onAddOffers, onOffersDone, onClose }) {
  const [phase, setPhase] = useState('pick') // pick | reading | review | applying | batch | adding
  const [file, setFile] = useState(null)
  const [readError, setReadError] = useState('')
  const [result, setResult] = useState(null)
  const [choice, setChoice] = useState([]) // по строке документа: ключ группы или null
  const [touched, setTouched] = useState(() => new Set()) // строки, где позицию выбрал человек
  const [checked, setChecked] = useState(() => new Set())
  const [vatMode, setVatMode] = useState('auto')
  const [vatRate, setVatRate] = useState(String(DEFAULT_VAT_RATE))
  const [withDelivery, setWithDelivery] = useState(true)
  const [attach, setAttach] = useState(filesOn)
  const [filter, setFilter] = useState('all')
  const [progress, setProgress] = useState(null)
  const [applyError, setApplyError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [batch, setBatch] = useState(null) // [{ file, status: reading | ready | error | saving | saved, error, notes, lines, matched }]
  const fileRef = useRef(null)
  const busy = phase === 'reading' || phase === 'applying' || phase === 'adding'
  const offersOn = filesOn && !!onAddOffers

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const groupByKey = useMemo(() => new Map(groups.map((g) => [g.key, g])), [groups])

  // ── Чтение и сопоставление ────────────────────────────────────────────────────────────────────────
  const readOne = async (f) => {
    setFile(f)
    setReadError('')
    setResult(null)
    setPhase('reading')
    const r = await readFile(f, groups)
    if (r.error) {
      setReadError(r.error)
      setPhase('pick')
      return
    }
    setResult(r)
    setChoice(r.matches.map((m) => m.match?.group.key || null))
    setTouched(new Set())
    setVatMode('auto')
    setVatRate(String(r.vat?.rate ?? DEFAULT_VAT_RATE))
    setFilter('all')
    setPhase('review')
  }

  // Несколько файлов — по очереди, каждый «в похожие цены» без окна сопоставления.
  const readMany = async (list) => {
    const items = list.slice(0, BATCH_MAX).map((f) => ({ file: f, status: 'reading' }))
    setReadError(list.length > BATCH_MAX ? `За один раз — не больше ${BATCH_MAX} файлов: остальные добавьте следующим заходом.` : '')
    setBatch(items)
    setPhase('batch')
    for (let i = 0; i < items.length; i++) {
      const r = await readFile(items[i].file, groups)
      const next = r.error
        ? { ...items[i], status: 'error', error: r.error }
        : { ...items[i], status: 'ready', ...batchNotes(r), kind: r.kind, pages: r.pages, sheetName: r.sheetName, vat: r.vat,
          matched: r.matches.filter((m) => m.match).length, goods: r.items.filter((it) => !it.delivery).length }
      items[i] = next
      setBatch([...items])
    }
  }

  const pickFiles = (fileList) => {
    const list = [...(fileList || [])]
    if (!list.length || busy) return
    if (list.length === 1 || !offersOn) readOne(list[0])
    else readMany(list)
  }

  // ── Цены и состояние строк ────────────────────────────────────────────────────────────────────────
  const vat = useMemo(() => {
    if (!result) return null
    if (vatMode === 'auto') return result.vat
    const rate = Number(String(vatRate).replace(',', '.'))
    return { mode: vatMode, rate: Number.isFinite(rate) && rate >= 0 && rate < 100 ? rate : DEFAULT_VAT_RATE, force: true }
  }, [result, vatMode, vatRate])

  const priceOf = useCallback((item) => unitPriceWithVat(item, vat), [vat])
  const delivery = useMemo(() => (result ? deliveryFactor(result.items, priceOf) : { factor: 1, delivery: 0, goods: 0 }), [result, priceOf])
  const factor = withDelivery ? delivery.factor : 1

  const lines = useMemo(() => {
    if (!result) return []
    return result.matches.map((m, i) => {
      const group = choice[i] ? groupByKey.get(choice[i]) : null
      const base = priceOf(m.item)
      const price = base != null && base > 0 ? roundMoney(base * factor) : null
      const cand = group ? (m.candidates.find((c) => c.group.key === group.key) || null) : null
      const unitOk = group ? groupUnitOk(m.item.unit, group) : true
      // Сейчас в расценке у позиций группы: своя другая цена — «заменит» (отмечает человек); цена из другого тендера —
      // «заменит цену из другого тендера»; пусто хотя бы где-то — «нет цены»; везде та же — «та же цена».
      let status = null
      if (group && price != null) {
        const cur = currentOf(group)
        const differ = [...new Set(cur.own.map(roundMoney).filter((p) => p !== price))]
        status = differ.length ? { kind: 'replace', prices: differ }
          : cur.copies ? { kind: 'copy' } : cur.empty ? { kind: 'new' } : { kind: 'same' }
      }
      return { i, item: m.item, candidates: m.candidates, group, cand, unitOk, price, status, delivery: m.item.delivery }
    })
  }, [result, choice, groupByKey, priceOf, factor, currentOf])

  // Отметки по умолчанию — когда пришли сопоставления: позиция найдена, ед. изм. та же, цена есть, своя цена позиции
  // не меняется (замену своей цены человек отмечает сам).
  const defaultsFor = useRef(null)
  useEffect(() => {
    if (!result || defaultsFor.current === result) return
    defaultsFor.current = result
    setChecked(new Set(lines.filter((l) => l.group && l.unitOk && l.price != null && l.status?.kind !== 'replace' && !l.delivery).map((l) => l.i)))
  }, [result, lines])

  const goods = lines.filter((l) => !l.delivery)
  const matched = goods.filter((l) => l.group)
  const review = matched.filter((l) => !l.cand?.exact)
  const shown = goods.filter((l) => (filter === 'matched' ? !!l.group : filter === 'unmatched' ? !l.group : filter === 'review' ? l.group && !l.cand?.exact : true))
  const toApply = goods.filter((l) => checked.has(l.i) && l.group && l.price != null)
  const targetsCount = toApply.reduce((s, l) => s + l.group.targets.length, 0)
  const deliveryLines = lines.filter((l) => l.delivery)
  // Какая строка документа держит позицию: выбрать её у другой строки — забрать (у прежней снимется).
  const takenBy = useMemo(() => {
    const m = new Map()
    choice.forEach((k, i) => { if (k) m.set(k, i) })
    return m
  }, [choice])

  const toggle = useCallback((i, on) => setChecked((prev) => {
    const next = new Set(prev)
    if (on) next.add(i); else next.delete(i)
    return next
  }), [])
  // Позиция — одной строке документа: выбрали занятую — у прежней строки сопоставление снимается.
  const choiceRef = useRef(choice)
  choiceRef.current = choice
  const pickGroup = useCallback((i, key) => {
    const at = key ? choiceRef.current.indexOf(key) : -1
    const freed = at >= 0 && at !== i ? at : null
    setChoice((prev) => prev.map((k, j) => (j === i ? key : key && k === key ? null : k)))
    setTouched((prev) => new Set(prev).add(i))
    setChecked((prev) => {
      const next = new Set(prev)
      if (key) next.add(i); else next.delete(i)
      if (freed != null) next.delete(freed)
      return next
    })
  }, [])

  // Строки документа — как их хранит «в похожие цены»: выбранная в окне позиция (k) и «не сопоставлять» руками (x).
  const reviewNotes = () => offerNotes({
    source: result.kind,
    vat,
    delivery: factor,
    lines: goods.map((l) => ({
      name: l.item.name, unit: l.item.unit, qty: l.item.qty, code: l.item.code, price: l.price,
      docPrice: docPriceOf(l.item), docVat: docVatOf(l.item), k: l.group?.k || null, skip: !l.group && touched.has(l.i),
    })),
  })

  const apply = async () => {
    if (!toApply.length) return
    setApplyError('')
    setPhase('applying')
    setProgress({ done: 0, total: targetsCount })
    let res
    try {
      res = await onApply({ lines: toApply.map((l) => ({ group: l.group, price: l.price })), file, attach: filesOn && attach, notes: reviewNotes() },
        (done, total) => setProgress({ done, total }))
    } catch (e) {
      res = { error: e.message || 'Цены не записаны' }
    }
    if (res?.error) {
      setApplyError(res.error)
      setPhase('review')
    }
  }

  const addOne = async () => {
    setApplyError('')
    setPhase('adding')
    try {
      await onAddOffers(file, reviewNotes())
      onOffersDone({ files: [file.name], lines: goods.filter((l) => l.price != null).length })
    } catch (e) {
      setApplyError(`Файл не добавлен в похожие цены: ${e.message || 'ошибка загрузки'}`)
      setPhase('review')
    }
  }

  const addBatch = async () => {
    const items = [...batch]
    setPhase('adding')
    for (let i = 0; i < items.length; i++) {
      if (items[i].status !== 'ready') continue
      items[i] = { ...items[i], status: 'saving' }
      setBatch([...items])
      try {
        await onAddOffers(items[i].file, items[i].notes)
        items[i] = { ...items[i], status: 'saved' }
      } catch (e) {
        items[i] = { ...items[i], status: 'ready', error: `не добавлен: ${e.message || 'ошибка загрузки'}` }
      }
      setBatch([...items])
    }
    const saved = items.filter((b) => b.status === 'saved')
    if (saved.length && !items.some((b) => b.status === 'ready')) {
      onOffersDone({ files: saved.map((b) => b.file.name), lines: saved.reduce((s, b) => s + b.lines, 0) })
      return
    }
    setPhase('batch')
  }

  const reset = () => { setPhase('pick'); setResult(null); setFile(null); setBatch(null); setApplyError(''); setReadError('') }

  // ── Отрисовка ─────────────────────────────────────────────────────────────────────────────────────
  const vatAuto = result?.vat?.mode
  const vatCue = result?.vat?.cue
  const inReview = (phase === 'review' || phase === 'applying' || phase === 'adding') && !!result
  const inBatch = !!batch && (phase === 'batch' || phase === 'adding')
  const batchReady = (batch || []).filter((b) => b.status === 'ready').length
  return (
    <div className="sp-modal-backdrop sp-modal-backdrop-full" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className={`sp-modal sp-modal-docimport${inReview ? ' is-full' : ''}`} role="dialog" aria-modal="true" aria-labelledby="sp-docimport-title">
        <h3 id="sp-docimport-title">Цены из счёта или КП поставщика</h3>
        <div className="sp-modal-body">
          {!inReview && !inBatch && (
            <>
              <p className="sp-muted">
                Загрузите счёт, КП или УПД поставщика в Excel или PDF: строки с ценами сопоставятся с позициями ВОР тендера.
                Проверьте сопоставление и примените цены — или добавьте документ «в похожие цены», чтобы выбирать цены у
                позиций в таблице.{offersOn ? ' Несколько файлов сразу добавляются «в похожие цены» без проверки.' : ''}
              </p>
              <div
                className={`sp-drop${dragOver ? ' is-over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFiles(e.dataTransfer.files) }}
              >
                <input ref={fileRef} type="file" accept={SUPPLIER_DOC_ACCEPT} multiple={offersOn} hidden
                  onChange={(e) => { pickFiles(e.target.files); e.target.value = '' }} />
                <button type="button" className="btn-primary" onClick={() => fileRef.current?.click()} disabled={busy}>
                  <IconUpload size={16} /> {offersOn ? 'Выбрать файлы' : 'Выбрать файл'}
                </button>
                <span className="sp-muted">или перетащите сюда · Excel (.xlsx, .xls, .csv) или PDF</span>
              </div>
              {phase === 'reading' && <p className="sp-drop-status" role="status">Распознаём «{file?.name}»…</p>}
              {readError && (
                <p className="sp-error-text sp-drop-status" role="alert"><IconAlert size={16} /> {file ? `«${file.name}»: ` : ''}{readError}</p>
              )}
            </>
          )}

          {inBatch && (
            <>
              <p className="sp-muted">
                Файлы добавятся «в похожие цены»: цены в расценку не пишутся, у позиций ВОР появятся «цены поставщиков» —
                выбирайте в таблице. НДС — как в документе («без НДС» — плюс ставка), доставка — к ценам пропорционально
                сумме. Проверить сопоставление и применить цены одного файла — загрузите его отдельно.
              </p>
              {readError && <p className="sp-error-text" role="alert">{readError}</p>}
              <ul className="sp-di-batch" aria-label="Файлы">
                {batch.map((b, i) => (
                  <li key={i} className={`is-${b.status}`}>
                    <span className="sp-di-file"><PaperclipIcon size={14} /> {b.file.name}</span>
                    <span className="sp-di-batch-state" role="status">
                      {b.status === 'reading' && 'распознаём…'}
                      {b.status === 'error' && <span className="sp-error-text"><IconAlert size={14} /> {b.error}</span>}
                      {(b.status === 'ready' || b.status === 'saving' || b.status === 'saved') && (
                        <>
                          {b.kind === 'pdf' ? `PDF, страниц: ${b.pages}` : `лист «${b.sheetName}»`}
                          {' · '}строк с ценой: <b className="ui-num">{b.lines}</b>
                          {' · '}похожих позиций ВОР: <b className="ui-num">{b.matched}</b>
                          {b.vat?.mode ? ` · ${VAT_TEXT[b.vat.mode]}` : ''}
                          {b.status === 'saving' && ' · добавляем…'}
                          {b.status === 'saved' && <span className="sp-di-saved"> · <IconCheck size={14} /> добавлен</span>}
                          {b.error && <span className="sp-error-text"> · {b.error}</span>}
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {inReview && (
            <>
              <div className="sp-di-summary">
                <span className="sp-di-file"><PaperclipIcon size={14} /> {file.name}</span>
                <span className="sp-muted">
                  {result.kind === 'pdf' ? `PDF, страниц: ${result.pages}` : `лист «${result.sheetName}»`}
                  {' · '}строк с ценой: <b className="ui-num">{goods.length}</b>
                  {' · '}сопоставлено с ВОР: <b className="ui-num">{matched.length}</b>
                </span>
                <button type="button" className="sp-link-btn" onClick={reset} disabled={busy}>другой файл</button>
              </div>

              <div className="sp-di-settings">
                <fieldset className="sp-di-vat" disabled={busy}>
                  <legend>НДС</legend>
                  <label>
                    <input type="radio" name="sp-di-vat" checked={vatMode === 'auto'} onChange={() => setVatMode('auto')} />
                    как в документе{vatAuto ? ` — ${VAT_TEXT[vatAuto]}` : ' — колонки «с НДС» / «без НДС», иначе цены как есть'}
                    {vatCue && <span className="sp-muted"> (в документе: «{vatCue}»)</span>}
                  </label>
                  <label>
                    <input type="radio" name="sp-di-vat" checked={vatMode === 'gross'} onChange={() => setVatMode('gross')} />
                    цены с НДС — как есть
                  </label>
                  <label>
                    <input type="radio" name="sp-di-vat" checked={vatMode === 'net'} onChange={() => setVatMode('net')} />
                    цены без НДС — добавить НДС
                    <input type="text" inputMode="decimal" className="sp-di-rate" value={vatRate} onChange={(e) => setVatRate(e.target.value)}
                      onFocus={() => setVatMode('net')} aria-label="Ставка НДС, %" /> %
                  </label>
                </fieldset>

                {deliveryLines.length > 0 && (
                  <label className="sp-di-delivery">
                    <input type="checkbox" checked={withDelivery} onChange={(e) => setWithDelivery(e.target.checked)} disabled={busy || !(delivery.factor > 1)} />
                    <span>
                      Доставка в документе: <b className="ui-num">{formatAmount(roundMoney(delivery.delivery))} ₽</b> — добавить к ценам
                      пропорционально сумме{delivery.factor > 1 ? ` (+${(Math.round((delivery.factor - 1) * 1000) / 10).toString().replace('.', ',')} %)` : ''}:
                      в расценке цена «с доставкой»
                    </span>
                  </label>
                )}
              </div>

              <div className="sp-di-filters">
                <div className="sp-filter" role="group" aria-label="Показать строки документа">
                  {[['all', `Все (${goods.length})`], ['matched', `Сопоставлены (${matched.length})`], ['review', `Проверить (${review.length})`],
                    ['unmatched', `Без позиции (${goods.length - matched.length})`]].map(([k, label]) => (
                    <button key={k} type="button" className={`sp-filter-btn${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
                  ))}
                </div>
                <span className="sp-muted sp-di-filter-hint">«Проверить» — сопоставлены по похожести, а не по тому же наименованию</span>
              </div>

              <div className="table-container sp-di-wrap">
                <table className="data-table sp-di-table">
                  <colgroup>
                    <col className="sp-di-c-sel" /><col className="sp-di-c-doc" /><col className="sp-di-c-price" />
                    <col className="sp-di-c-pos" /><col className="sp-di-c-now" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th><span className="ui-sr-only">Применить</span></th>
                      <th>Строка документа</th>
                      <th className="ui-money" title="Цена за единицу с НДС и доставкой — как запишется в расценку">Цена в расценку, ₽</th>
                      <th>Позиция ВОР</th>
                      <th>Сейчас в расценке</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((l) => (
                      <DocLine key={l.i} line={l} checked={checked.has(l.i)} busy={busy} groups={groups} takenBy={takenBy}
                        onCheck={toggle} onPick={pickGroup} />
                    ))}
                    {!shown.length && <tr><td colSpan={5} className="no-data">Строк нет</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {applyError && <p className="sp-error-text" role="alert">{applyError}</p>}
        </div>
        <div className="sp-modal-actions sp-di-actions">
          {inReview && filesOn && (
            <label className="sp-di-attach">
              <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} disabled={busy} />
              Прикрепить файл документом к позициям, получившим цену
            </label>
          )}
          {inBatch && <span className="sp-di-attach" />}
          {phase === 'applying' && progress && (
            <span className="sp-di-progress" role="status">Сохраняем цены: {progress.done} из {progress.total}…</span>
          )}
          {inBatch && (
            <button type="button" className="btn-secondary" onClick={reset} disabled={busy}>Другие файлы</button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Отмена</button>
          {inReview && offersOn && (
            <button type="button" className="btn-secondary" onClick={addOne} disabled={busy || !goods.some((l) => l.price != null)}
              title="Цены не пишутся: у позиций ВОР появятся цены этого документа — выбирать в таблице">
              {phase === 'adding' ? 'Добавляем…' : 'Только в похожие цены'}
            </button>
          )}
          {inReview && (
            <button type="button" className="btn-primary" onClick={apply} disabled={busy || !toApply.length}>
              {phase === 'applying' ? 'Применяем…' : `Применить цены: ${toApply.length}${targetsCount > toApply.length ? ` (позиций ВОР: ${targetsCount})` : ''}`}
            </button>
          )}
          {inBatch && (
            <button type="button" className="btn-primary" onClick={addBatch}
              disabled={busy || !batchReady || batch.some((b) => b.status === 'reading')}>
              {phase === 'adding' ? 'Добавляем…' : `Добавить в похожие цены: ${batchReady}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// Строка документа: отметка, наименование и цена из документа, цена в расценку, позиция ВОР (список выбора), что
// сейчас в расценке. Отметка в соседней строке её не перерисовывает.
const DocLine = memo(function DocLine({ line, checked, busy, groups, takenBy, onCheck, onPick }) {
  const { item, group, price, status } = line
  const docPrice = docPriceOf(item)
  const vatTag = docVatOf(item) === 'net' ? 'без НДС' : docVatOf(item) === 'gross' ? 'с НДС' : ''
  return (
    <tr className={[!group && 'is-unmatched', checked && 'is-checked'].filter(Boolean).join(' ')}>
      <td className="sp-di-sel">
        <input type="checkbox" checked={checked} disabled={busy || !group || price == null} onChange={(e) => onCheck(line.i, e.target.checked)}
          aria-label={`Применить цену: ${item.name}`} />
      </td>
      <td className="sp-di-doc">
        <span className="sp-di-name">{item.name}</span>
        <span className="sp-di-meta">
          {item.code && <span>арт. {item.code}</span>}
          {item.qty != null && <span className="ui-num">{String(item.qty).replace('.', ',')} {item.unit || ''}</span>}
          {item.qty == null && item.unit && <span>{item.unit}</span>}
          {docPrice != null && <span className="ui-num">в документе {formatAmount(roundMoney(docPrice))}{vatTag ? ` ${vatTag}` : ''}</span>}
          {item.source && <span>{item.source}</span>}
        </span>
      </td>
      <td className="ui-money sp-di-price">{price != null ? formatAmount(price) : '—'}</td>
      <td className="sp-di-pos">
        <PositionChoice line={line} groups={groups} takenBy={takenBy} busy={busy} onPick={onPick} />
      </td>
      <td className="sp-di-now">
        {!group || !status ? <span className="sp-muted">—</span>
          : status.kind === 'replace' ? <span className="sp-di-tag is-warn">заменит {status.prices.slice(0, 2).map((p) => formatAmount(p)).join(', ')}</span>
            : status.kind === 'same' ? <span className="sp-muted">та же цена</span>
              : status.kind === 'copy' ? <span>заменит цену из другого тендера</span>
                : <span>нет цены</span>}
      </td>
    </tr>
  )
})

// Позиция ВОР строки документа: «не сопоставлять» и сразу под ним самые похожие позиции (кружки), «ещё N» — остальные
// кандидаты, поиск — среди всех позиций ВОР. Позиция другой строки — с пометкой: выбрать её здесь — забрать.
function PositionChoice({ line, groups, takenBy, busy, onPick }) {
  const [more, setMore] = useState(false)
  const [query, setQuery] = useState('')
  const { item, group, candidates } = line
  const found = useMemo(() => (query.trim() ? searchGroups(query, groups, SEARCH_LIMIT) : null), [query, groups])
  const candOf = (g) => candidates.find((c) => c.group.key === g.key) || null
  let options = found
    ? found.map((g) => candOf(g) || { group: g, score: null, found: true })
    : (more ? candidates : candidates.slice(0, VISIBLE_OPTIONS))
  if (group && !options.some((c) => c.group.key === group.key)) options = [candOf(group) || { group, score: null, found: true }, ...options]
  const hidden = found ? 0 : candidates.filter((c) => !options.includes(c)).length
  const name = `sp-di-pos-${line.i}`
  return (
    <div className="sp-di-choice" role="radiogroup" aria-label={`Позиция ВОР для «${item.name}»`}>
      <label className={`sp-di-opt is-none${!group ? ' is-on' : ''}`}>
        <input type="radio" name={name} checked={!group} disabled={busy} onChange={() => onPick(line.i, null)} />
        <span className="sp-di-opt-name">не сопоставлять</span>
      </label>
      {options.map((c) => {
        const on = group?.key === c.group.key
        const other = takenBy.get(c.group.key)
        const unitOk = groupUnitOk(item.unit, c.group)
        return (
          <label key={c.group.key} className={`sp-di-opt${on ? ' is-on' : ''}`}>
            <input type="radio" name={name} checked={on} disabled={busy} onChange={() => onPick(line.i, c.group.key)} />
            <span className="sp-di-opt-name">{c.group.name}</span>
            <span className="sp-di-opt-meta">
              <span>{unitText(c.group)}</span>
              {c.exact ? <span className="sp-di-tag is-exact"><IconCheck size={12} /> то же наименование</span>
                : c.code ? <span className="sp-di-tag is-exact">артикул совпал · {pct(c.score)}</span>
                  : c.score != null ? <span className="sp-di-tag">похоже на {pct(c.score)}{c.apart ? ' · числа другие' : ''}</span>
                    : <span className="sp-di-tag">найдено поиском</span>}
              {!unitOk && <span className="sp-di-tag is-warn">ед. изм.: в документе «{item.unit}»</span>}
              {c.group.targets.length > 1 && <span>в {c.group.targets.length} ВОР</span>}
              {other != null && other !== line.i && <span className="sp-di-taken">сейчас у другой строки документа</span>}
            </span>
          </label>
        )
      })}
      {found && !found.length && <span className="sp-muted sp-di-none">Ничего не нашли</span>}
      <div className="sp-di-tools">
        <label className="ui-search sp-di-find">
          <IconSearch size={14} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти среди всех позиций ВОР" disabled={busy}
            aria-label={`Найти позицию ВОР для «${item.name}»`}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }} />
        </label>
        {hidden > 0 && <button type="button" className="sp-link-btn" onClick={() => setMore(true)}>ещё {hidden}</button>}
        {!found && more && candidates.length > VISIBLE_OPTIONS && (
          <button type="button" className="sp-link-btn" onClick={() => setMore(false)}>свернуть</button>
        )}
      </div>
    </div>
  )
}
