import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatAmount } from '../../utils/money'
import { offerPrice } from '../../utils/supplyDocMatch'
import { nameDiff } from '../../utils/supplyNameDiff'
import { GRADES, GRADE_INFO, gradeSummary, moscowDay } from '../../utils/supplyPriceSearch'
import { fmtPriceDate, isFreshPriceDate } from '../../utils/supplyRateHelpers'
import { isWebLink } from '../../services/supplyPricing'
import { loadRateDocs } from '../../services/supplyPriceSources'
import { IconClose, IconSearch } from '../icons/ToolbarIcons'

// Окно цен позиции (26.11.2026, вместо выпадающего меню «похожие цены»: оно закрывалось от любой прокрутки и щелчка мимо, было узким
// и смешивало цены разной похожести). Все цены, какие нашлись, — разделами по ступеням похожести (utils/supplyPriceSearch: та же
// позиция → очень похожие → уточнённые модели → похожие → отдалённо, последние свёрнуты), у раздела — разброс цен (мин. · медиана ·
// макс.). Источники вперемешку, у каждой цены — откуда она: счета и КП этого тендера (offers), цены других тендеров и других ВОР этого
// (prices.tender), реестр СУ-10 — загрузки из Excel и строки счетов других тендеров (prices.registry). Цена старше 3 месяцев —
// предлагается, с красной пометкой (решение пользователя 26.11.2026). У наименования с несколькими ценами видна свежая, остальные —
// «ещё N цен». Фильтр по источнику и словам; не нашлось — «Искать по всем ценам» (onSearch: те же источники по словам запроса).
// «Взять» — как раньше: цена поставщика — своя цена и файл документом (onPickOffer), цена тендера — с отметкой источника и документом
// исходной позиции (onPickRate), цена реестра — своя цена (onPickRegistry). Закрывается только крестиком, «Закрыть» и Esc.
// Клавиатура: стрелки — по ценам, Enter — взять.
const SOURCE_FILTERS = [['all', 'Все'], ['offer', 'Счета и КП тендера'], ['tender', 'Тендеры'], ['registry', 'Реестр СУ-10']]
const KIND_ORDER = { offer: 0, tender: 1, registry: 2 }
const SEARCH_DELAY_MS = 300
const DOCS_MAX = 150

const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '')
const fmtNum = (v) => String(Math.round(Number(v) * 1000) / 1000).replace('.', ',')
const words = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean)

// Цены в один вид: { id, kind, grade, name, unit, points: [{ id, price, day, stale, row?, offer? }], current, offer? }.
function offerItems(offers, currentPrice, unit) {
  return (offers || []).map((o, i) => {
    const day = moscowDay(o.line.doc?.created_at)
    const price = offerPrice(o)
    return {
      id: `o:${o.line.doc?.id}:${i}`, kind: 'offer', grade: o.grade || 'same', name: o.line.name,
      unit: o.pack ? unit || 'ед.' : o.line.unit || unit || 'ед.', current: currentPrice != null && price === currentPrice,
      points: [{ id: `o:${i}`, price, day, stale: !!day && !isFreshPriceDate(day), offer: o }], offer: o,
    }
  })
}
function entryItems(entries, kind, unit, currentSourceId) {
  return (entries || []).map((e) => ({
    id: `${kind}:${e.key}`, kind, grade: e.grade, name: e.group.name, unit: unit || e.group.unit || 'ед.', entry: e,
    current: e.points.some((p) => p.row.id === currentSourceId),
    points: e.points.map((p) => ({ id: p.row.id, price: p.price, day: p.row.day, stale: p.stale, row: p.row })),
  }))
}
const itemStale = (it) => it.points.every((p) => p.stale)
const byItem = (a, b) => Number(b.current) - Number(a.current) || Number(itemStale(a)) - Number(itemStale(b))
  || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || String(b.points[0]?.day || '').localeCompare(String(a.points[0]?.day || ''))
  || a.points[0].price - b.points[0].price

export default function SupplyPriceWindow({
  row, editable, currentPrice = null, currentSourceId = null, offers = null, prices, otherUnit = null,
  onPickOffer, onPickRate, onPickRegistry, onPickOtherUnit, onSearch, onOpenFile, onClose,
}) {
  const unit = row.p.unit || ''
  const [source, setSource] = useState('all')
  const [query, setQuery] = useState('')
  const [farOpen, setFarOpen] = useState(false)
  const [docs, setDocs] = useState(() => new Map())
  const [search, setSearch] = useState(null) // { q, items }
  const boxRef = useRef(null)

  const allItems = useMemo(() => [
    ...offerItems(offers, currentPrice, unit),
    ...entryItems(prices.tender, 'tender', unit, currentSourceId),
    ...entryItems(prices.registry, 'registry', unit, currentSourceId),
  ], [offers, prices.tender, prices.registry, currentPrice, currentSourceId, unit])

  // Документы исходных позиций цен тендеров — для «документ: …» и «Взять».
  useEffect(() => {
    const rows = allItems.filter((it) => it.kind === 'tender').flatMap((it) => it.points.map((p) => p.row)).slice(0, DOCS_MAX)
    if (!rows.length) return undefined
    let alive = true
    loadRateDocs(rows).then((m) => { if (alive && m.size) setDocs((prev) => new Map([...prev, ...m])) })
    return () => { alive = false }
  }, [allItems])

  const q = words(query)
  const counts = useMemo(() => {
    const c = { all: allItems.length, offer: 0, tender: 0, registry: 0 }
    for (const it of allItems) c[it.kind] += 1
    return c
  }, [allItems])
  const shown = useMemo(() => allItems.filter((it) => (source === 'all' || it.kind === source)
    && (!q.length || q.every((w) => it.name.toLowerCase().replace(/ё/g, 'е').includes(w)))), [allItems, source, q])
  const byGrade = useMemo(() => GRADES.map((grade) => {
    const items = shown.filter((it) => it.grade === grade).sort(byItem)
    return { grade, items, summary: gradeSummary(items.map((it) => it.points[0].price)) }
  }).filter((g) => g.items.length), [shown])

  // Поиск по всем ценам по словам запроса — когда среди найденного под фильтр ничего не подошло или человек попросил сам.
  const qText = query.trim()
  useEffect(() => {
    if (!qText || !onSearch) { setSearch(null); return undefined }
    const t = setTimeout(() => {
      const found = onSearch(qText)
      setSearch({ q: qText, items: [...entryItems(found.tender, 'tender', unit, currentSourceId), ...entryItems(found.registry, 'registry', unit, currentSourceId)] })
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(t)
  }, [qText, onSearch, unit, currentSourceId])
  const searchItems = useMemo(() => {
    if (!search || search.q !== qText) return []
    const have = new Set(shown.map((it) => it.id))
    return search.items.filter((it) => !have.has(it.id) && (source === 'all' || it.kind === source)).sort(byItem)
  }, [search, qText, shown, source])

  const close = useCallback((restore) => onClose(restore), [onClose])
  useEffect(() => {
    const onKey = (e) => {
      // Поверх окна открыт просмотр файла цены — Esc закрывает его, а не окно цен.
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.s3-doc-modal-overlay')) return
      e.preventDefault()
      close(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close])
  useEffect(() => { (boxRef.current?.querySelector('[data-item]') || boxRef.current)?.focus() }, [])

  const onListKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    if (e.target.tagName === 'INPUT') return
    e.preventDefault()
    const items = [...(boxRef.current?.querySelectorAll('[data-item]') || [])]
    if (!items.length) return
    const i = items.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1)
    items[next].focus()
  }

  const take = (it, p) => {
    if (!editable) return
    if (it.kind === 'offer') onPickOffer(it.offer)
    else if (it.kind === 'tender') onPickRate(p.row, p.price, it.entry, docs.get(p.row.id) || null)
    else onPickRegistry(p.row, p.price, it.entry)
  }

  const loading = []
  if (offers === null) loading.push('цены из счетов и КП тендера ещё подбираются')
  if (prices.tender === null) loading.push('загружаем цены тендеров')
  if (prices.registryState === 'loading') loading.push('ищем в реестре СУ-10')
  const title = `Цены: ${row.p.name}`
  const nothing = !byGrade.length && !searchItems.length && !otherUnit?.length
  const far = byGrade.find((g) => g.grade === 'far')
  const near = byGrade.filter((g) => g.grade !== 'far')

  return createPortal(
    <div className="sp-modal-backdrop sp-pw-backdrop" role="presentation">
      <div ref={boxRef} className="sp-modal sp-pw" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={onListKey}>
        <div className="sp-pw-head">
          <div className="sp-pw-head-text">
            <h3>Цены позиции</h3>
            <div className="sp-pw-pos">{row.p.name}</div>
            <div className="sp-pw-sub">
              <span>{unit || 'ед. изм. не указана'}</span>
              {row.p.volume != null && <span className="ui-num">объём {fmtNum(row.p.volume)}</span>}
              {currentPrice != null && <span className="ui-num">сейчас: {formatAmount(currentPrice)} ₽</span>}
            </div>
          </div>
          <button type="button" className="sp-pw-close" onClick={() => close(true)} aria-label="Закрыть окно цен"><IconClose size={18} /></button>
        </div>
        <div className="sp-pw-tools">
          <div className="sp-pw-sources" role="group" aria-label="Откуда цены">
            {SOURCE_FILTERS.map(([k, label]) => (
              <button key={k} type="button" className={`sp-pw-chip${source === k ? ' is-on' : ''}`} aria-pressed={source === k}
                disabled={k !== 'all' && !counts[k]} onClick={() => setSource(k)}>
                {label} <span className="ui-num">{counts[k]}</span>
              </button>
            ))}
          </div>
          <label className="sp-pw-search">
            <IconSearch size={14} />
            <input type="search" value={query} placeholder="Слова наименования, марка, артикул" aria-label="Найти среди цен"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setQuery('') } }} />
          </label>
        </div>
        <div className="sp-pw-body">
          {loading.length > 0 && <p className="sp-pw-loading" role="status">{loading.join(', ')}…</p>}
          {near.map((g) => <GradeSection key={g.grade} g={g} row={row} unit={unit} editable={editable} docs={docs} onTake={take} onOpenFile={onOpenFile} />)}
          {far && (farOpen || !near.length
            ? <GradeSection g={far} row={row} unit={unit} editable={editable} docs={docs} onTake={take} onOpenFile={onOpenFile}
              onHide={near.length ? () => setFarOpen(false) : null} />
            : (
              <button type="button" className="sp-pw-more-grade" onClick={() => setFarOpen(true)}>
                {GRADE_INFO.far.title}: <span className="ui-num">{far.items.length}</span> — показать
                <span className="sp-muted"> ({GRADE_INFO.far.hint})</span>
              </button>
            ))}
          {searchItems.length > 0 && (
            <GradeSection g={{ grade: 'search', items: searchItems, summary: gradeSummary(searchItems.map((it) => it.points[0].price)) }}
              title={`По словам «${qText}» среди всех цен`} row={row} unit={unit} editable={editable} docs={docs} onTake={take} onOpenFile={onOpenFile} />
          )}
          {otherUnit?.length > 0 && source !== 'offer' && source !== 'registry' && (
            <section className="sp-pw-grade is-other">
              <div className="sp-pw-grade-head">
                <span className="sp-pw-grade-title">В другой ед. изм.</span>
                <span className="sp-muted">сами не подставляются: проверьте единицу, прежде чем взять цену</span>
              </div>
              <ul className="sp-pw-list" aria-label="Цены в другой ед. изм.">
                {otherUnit.map((o) => <OtherUnitItem key={o.rate.id} o={o} unit={unit} editable={editable} onPick={onPickOtherUnit} />)}
              </ul>
            </section>
          )}
          {nothing && !loading.length && (
            <p className="sp-pw-empty">{q.length ? 'Под фильтр ничего не подошло.' : 'Похожих цен не нашли.'} Попробуйте другие слова в поиске — марку, серию или артикул.</p>
          )}
        </div>
        <div className="sp-modal-actions">
          <button type="button" className="btn-secondary" onClick={() => close(true)}>Закрыть</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function GradeSection({ g, title = null, row, unit, editable, docs, onTake, onOpenFile, onHide = null }) {
  const info = GRADE_INFO[g.grade]
  const s = g.summary
  return (
    <section className={`sp-pw-grade is-${g.grade}`} aria-label={title || info.title}>
      <div className="sp-pw-grade-head">
        <span className="sp-pw-grade-title">{title || info.title}</span>
        <span className="sp-pw-grade-count ui-num">{g.items.length}</span>
        {info && <span className="sp-muted sp-pw-grade-hint">{info.hint}</span>}
        {s && (
          <span className="sp-pw-range ui-num" title="Самая низкая · медиана · самая высокая (по свежей цене каждого наименования)">
            {s.n > 1 ? <>{formatAmount(s.min)} · <b>{formatAmount(s.median)}</b> · {formatAmount(s.max)} ₽</> : <>{formatAmount(s.min)} ₽</>}
          </span>
        )}
        {onHide && <button type="button" className="sp-link-btn" onClick={onHide}>свернуть</button>}
      </div>
      <ul className="sp-pw-list">
        {g.items.map((it) => <PriceItem key={it.id} it={it} row={row} unit={unit} editable={editable} docs={docs} onTake={onTake} onOpenFile={onOpenFile} />)}
      </ul>
    </section>
  )
}

// Наименование с подсвеченным тем, чего нет в позиции (слова и числа).
function Name({ text, other }) {
  const parts = useMemo(() => nameDiff(text, other), [text, other])
  return <span className="sp-pw-name">{parts.map((p, i) => (p.differs ? <mark key={i} className="sp-pw-diff">{p.text}</mark> : <span key={i}>{p.text}</span>))}</span>
}

const Stale = () => <span className="sp-pw-stale">старше 3 месяцев</span>

// Откуда цена: источник, тендер, объект, ВОР или файл, день; документ исходной позиции.
function PointMeta({ it, p, docs, onOpenFile }) {
  if (it.kind === 'offer') {
    const { line } = p.offer
    const docVat = line.docVat === 'net' ? ' без НДС' : line.docVat === 'gross' ? ' с НДС' : ''
    return (
      <span className="sp-pw-meta">
        <span className="sp-pw-src is-offer">счёт / КП тендера</span>
        <button type="button" className="link sp-doc-copy" title={`Открыть «${line.doc.file_name}»`} onClick={() => onOpenFile?.(line.doc)}>{line.doc.file_name}</button>
        {line.doc.created_at && <span className="ui-num">{fmtDay(line.doc.created_at)}</span>}
        {p.stale && <Stale />}
        {line.doc.uploaded_by_name && <span>{line.doc.uploaded_by_name}</span>}
        {line.docPrice != null && <span className="ui-num">в документе {formatAmount(line.docPrice)}{docVat}</span>}
        {line.qty != null && <span className="ui-num">{String(line.qty).replace('.', ',')} {line.unit || ''}</span>}
      </span>
    )
  }
  const r = p.row
  const doc = docs.get(r.id)
  return (
    <span className="sp-pw-meta">
      {r.source === 'tender'
        ? <span className="sp-pw-src is-tender">{r.tenderNumber != null ? `тендер № ${r.tenderNumber}` : 'тендер без номера'}</span>
        : <span className="sp-pw-src is-registry">{r.source === 'doc' ? 'реестр: счёт тендера' : 'реестр СУ-10'}</span>}
      <span className="ui-num">{fmtPriceDate(r.day)}</span>
      {p.stale && <Stale />}
      {r.objectName && <span>{r.objectName}</span>}
      {r.estimateName && <span>ВОР «{r.estimateName}»</span>}
      {r.tenderDesc && <span className="sp-pw-clip" title={r.tenderDesc}>{r.tenderDesc}</span>}
      {r.contractor && <span>{r.contractor}</span>}
      {r.source === 'import' && r.sourceName && <span>{r.sourceName}</span>}
      {r.docName && <span className="sp-pw-clip" title={r.docName}>{r.docName}</span>}
      {isWebLink(r.invoiceUrl) && <a href={r.invoiceUrl} target="_blank" rel="noopener noreferrer" className="link">счёт</a>}
      {doc?.doc_key ? (
        <button type="button" className="link sp-doc-copy" title={doc.doc_name || 'файл'}
          onClick={() => onOpenFile?.({ id: doc.doc_id, file_name: doc.doc_name, s3_key: doc.doc_key })}>документ: файл</button>
      ) : doc?.url && (isWebLink(doc.url)
        ? <a href={doc.url} target="_blank" rel="noopener noreferrer" className="link" title={doc.url}>документ: Открыть</a>
        : <span title={doc.url}>документ: сетевой путь</span>)}
    </span>
  )
}

const PriceItem = memo(function PriceItem({ it, row, unit, editable, docs, onTake, onOpenFile }) {
  const [open, setOpen] = useState(false)
  const main = it.points[0]
  const rest = it.points.length - 1
  const tags = []
  if (it.kind === 'offer') {
    const o = it.offer
    if (o.picked) tags.push(['выбрано вручную'])
    else if (o.exact) tags.push(['то же наименование'])
    else tags.push([`похоже на ${Math.round(o.score * 100)} %`, 'is-score'])
    if (!o.unitOk) tags.push([`в документе — «${o.line.unit}»`, 'is-warn'])
    if (o.pack != null) tags.push([`1 ${o.line.unit} = ${String(o.pack).replace('.', ',')} ${unit}: ${formatAmount(o.line.price)} ₽ за ${o.line.unit}`])
  } else {
    const e = it.entry
    if (e.exact) tags.push(['то же наименование'])
    else tags.push([`похоже на ${Math.round(e.score * 100)} %`, 'is-score'])
    if (e.pack) tags.push([`пересчёт: 1 ${unit} = ${fmtNum(e.pack)} ${e.group.unit}, в источнике ${formatAmount(main.row.price)} ₽ за ${e.group.unit}`])
  }
  const takeLabel = (p) => `Взять цену ${formatAmount(p.price)} ₽: ${it.name}`
  return (
    <li className={`sp-pw-item is-${it.kind}${it.current ? ' is-current' : ''}${itemStale(it) ? ' is-stale' : ''}`} data-item="" tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget && !it.current) { e.preventDefault(); onTake(it, main) } }}
      aria-label={`${it.name}, ${formatAmount(main.price)} ₽ за ${unit || it.unit}`}>
      <div className="sp-pw-info">
        <div>
          <Name text={it.name} other={row.p.name} />
          {tags.map(([t, cls]) => <span key={t} className={`sp-suggest-tag${cls ? ` ${cls}` : ''}`}>{t}</span>)}
          {it.current && <span className="sp-suggest-tag is-current">сейчас в позиции</span>}
        </div>
        <PointMeta it={it} p={main} docs={docs} onOpenFile={onOpenFile} />
        {rest > 0 && (
          <button type="button" className="sp-link-btn sp-pw-rest" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'скрыть цены' : `ещё цен: ${rest}`}
          </button>
        )}
        {open && (
          <ul className="sp-pw-points">
            {it.points.slice(1).map((p) => (
              <li key={p.id}>
                <span className="sp-pw-point-price ui-num">{formatAmount(p.price)} ₽</span>
                <PointMeta it={it} p={p} docs={docs} onOpenFile={onOpenFile} />
                {editable && <button type="button" className="btn-secondary sp-suggest-take" onClick={() => onTake(it, p)} aria-label={takeLabel(p)}>Взять</button>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="sp-pw-side">
        <span className="sp-pw-price ui-num">{formatAmount(main.price)} ₽<span className="sp-muted"> за {unit || it.unit}</span></span>
        {editable && !it.current && (
          <button type="button" className="btn-secondary sp-suggest-take" onClick={() => onTake(it, main)} aria-label={takeLabel(main)}>Взять</button>
        )}
      </div>
    </li>
  )
})

// Цена другого тендера в другой ед. изм.: пометка единицы, что с ней делать (пересчёт, ошибка в ВОР), «Взять».
function OtherUnitItem({ o, unit, editable, onPick }) {
  const { rate, sameName, spelled, cubic, converted } = o
  const stale = !isFreshPriceDate(rate.price_date)
  return (
    <li className="sp-pw-item" data-item="" tabIndex={-1}
      aria-label={`${rate.material_name}, ${formatAmount(rate.price)} ₽ за ${rate.unit}, другая ед. изм.`}>
      <div className="sp-pw-info">
        <div>
          <span className="sp-pw-name">{rate.material_name}</span>
          {sameName && <span className="sp-suggest-tag">то же наименование</span>}
          <span className={`sp-suggest-tag${spelled ? '' : ' is-warn'}`}>{spelled ? `та же ед. изм., записана иначе: «${rate.unit}»` : `другая ед. изм.: цена за ${rate.unit}, здесь ${unit}`}</span>
        </div>
        <span className="sp-pw-meta">
          <span className="sp-pw-src is-tender">{rate.tender_number != null ? `тендер № ${rate.tender_number}` : 'тендер без номера'}</span>
          <span className="ui-num">{fmtPriceDate(rate.price_date)}</span>
          {stale && <Stale />}
          {rate.object_name && <span>{rate.object_name}</span>}
          <span>ВОР «{rate.estimate_name}»</span>
        </span>
        {cubic && <span className="sp-pw-meta sp-suggest-note">Объём позиции похож на м3 ({fmtNum(cubic.area)} м2 × {fmtNum(cubic.thickness)} м): вероятно, в ВОР ошибка в ед. изм., цена за м3 подойдёт как есть.</span>}
        {converted && <span className="sp-pw-meta sp-suggest-note">Пересчёт: 1 {rate.unit} = {fmtNum(converted.pack)} {unit} — {formatAmount(converted.price)} ₽ за {unit}.</span>}
      </div>
      <div className="sp-pw-side">
        <span className="sp-pw-price ui-num">{formatAmount(rate.price)} ₽<span className="sp-muted"> за {rate.unit}</span></span>
        {editable && converted && (
          <button type="button" className="btn-secondary sp-suggest-take" onClick={() => onPick(o, true)}
            aria-label={`Взять цену ${formatAmount(converted.price)} ₽ за ${unit}: ${rate.material_name}`}>Взять {formatAmount(converted.price)}</button>
        )}
        {editable && (
          <button type="button" className="btn-secondary sp-suggest-take" onClick={() => onPick(o, false)}
            aria-label={`Взять цену ${formatAmount(rate.price)} ₽ как есть: ${rate.material_name}`}>{spelled || cubic ? 'Взять' : 'Как есть'}</button>
        )}
      </div>
    </li>
  )
}
