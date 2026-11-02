import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconAlert, IconCheck } from '../icons/ActionIcons'
import { IconSearch } from '../icons/ToolbarIcons'
import PaperclipIcon from '../icons/PaperclipIcon'
import { formatAmount, roundMoney } from '../../utils/money'
import { DEFAULT_VAT_RATE, unitPriceWithVat } from '../../utils/supplierDoc'
import { deliveryFactor, docPack, groupUnitOk, matchDocItems, packQtyFar, searchGroups } from '../../utils/supplyDocMatch'
import { docPriceOf, docVatOf, linePrice, packPrice } from '../../utils/supplyDocPrice'
import { priceStatus } from '../../utils/supplyAutoPick'
import { offerNotes } from '../../utils/supplyOffers'

// Сколько позиций ВОР видно у строки документа сразу (остальные кандидаты — «ещё N», любые — поиском).
const VISIBLE_OPTIONS = 4
const SEARCH_LIMIT = 12

const pct = (s) => `${Math.round(s * 100)} %`
const VAT_TEXT = { gross: 'цены с НДС', net: 'цены без НДС — НДС добавится', none: 'НДС не облагается — цены как есть' }
const unitText = (g) => g.unit || (g.units || []).join(', ') || '—'
const packOf = (item, g) => (g.units ? null : docPack(item, g.unit, g.name))
const packText = (n) => String(Math.round(n * 1000000) / 1000000).replace('.', ',')
const positiveNumber = (v) => {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}

// Распознанный документ → с сопоставлениями. Доставка — не позиция ВОР: не сопоставляется (и не забирает позицию у
// строки с материалом).
function withMatches(r, groups) {
  const goodsMatches = matchDocItems(r.items.filter((it) => !it.delivery), groups, { packs: true })
  let k = 0
  return { ...r, matches: r.items.map((item) => (item.delivery ? { item, match: null, also: [], candidates: [] } : goodsMatches[k++])) }
}
// Выбранные позиции строк: выбор, сохранённый при файле (saved — строки notes), иначе найденная и остальные с тем же
// материалом. Сохранённый выбор — по наименованию строки.
function choiceOf(matches, groups, saved) {
  const byName = new Map((saved || []).filter((l) => l.k || l.skip).map((l) => [l.name, l]))
  const keysOf = (k) => groups.filter((g) => g.k === k).map((g) => g.key)
  return matches.map((m) => {
    const was = byName.get(String(m.item.name).replace(/\s+/g, ' ').trim())
    if (was?.skip) return []
    if (was?.k) {
      const keys = [was.k, ...(was.also || [])].flatMap(keysOf)
      if (keys.length) return keys
    }
    return m.match ? [m.match.group.key, ...m.also.map((c) => c.group.key)] : []
  })
}

// Проверка одного файла построчно: строки документа сопоставлены с позициями ВОР тендера (точно — по наименованию,
// иначе — по артикулу и похожести: слова и числа, текст целиком), человек проверяет — у каждой строки «не сопоставлять» и
// сразу под ним самые похожие позиции, поиск по всем, отметить можно несколько (тот же материал под разной записью в
// разных ВОР), — выбирает, считать ли цены с НДС и разносить ли доставку, и либо применяет (цены пишутся в расценку, как
// ввод руками, файл — документом к позициям, получившим цену), либо оставляет цены в «похожих» (цены не пишутся: выбор
// сохраняется при файле). Цена за упаковку или бухту делится на единицу позиции (utils/supplyDocMatch.docPack: «(50шт)»,
// «305м»); не сказано, сколько, — можно указать тут же. Цены в валюте — только с курсом.
// groups — позиции ВОР, сложенные в одинаковые (utils/supplyDocMatch.positionGroups). preset — файл уже прочитан:
// { file, doc, read, attached, saved } (doc — строка s3_documents, attached — к скольким позициям только что прикреплён,
// saved — строки notes). currentOf(group) — что сейчас
// в расценке: { own: [цены с доставкой], copies, empty }. deliveryOn — в расценке есть колонка «Доставка» (миграция
// 20261120): доставка документа (колонкой строки или строкой «Доставка», разнесённой пропорционально сумме) пишется в
// неё за единицу, а не в цену. onApply({ lines: [{ group, price, delivery }], file, attach, notes, existing }, onProgress) —
// записать; ответ { error } оставляет окно открытым. onAddOffers(file, notes, existing) — только строки при файле (ошибка —
// исключением); onOffersDone({ files, lines }) — сохранено (панель закрывает окно и пишет, что сделано).
export default function SupplyDocImportDialog({ groups, preset, currentOf, filesOn, deliveryOn = false, onApply, onAddOffers, onOffersDone, onClose }) {
  const [phase, setPhase] = useState('review') // review | applying | adding
  const file = preset.file
  const existing = preset.doc || null
  const [result] = useState(() => withMatches(preset.read, groups))
  const [choice, setChoice] = useState(() => choiceOf(result.matches, groups, preset.saved)) // по строке документа: ключи групп
  const [touched, setTouched] = useState(() => new Set()) // строки, где позицию выбрал человек
  const [checked, setChecked] = useState(() => new Set())
  const [vatMode, setVatMode] = useState('auto')
  const [vatRate, setVatRate] = useState(String(preset.read.vat?.rate ?? DEFAULT_VAT_RATE))
  const [fxRate, setFxRate] = useState('') // курс, если цены документа не в рублях
  const [packEdits, setPackEdits] = useState({}) // «строка:позиция» → сколько единиц позиции в единице документа, указал человек
  const [withDelivery, setWithDelivery] = useState(true)
  const [attach, setAttach] = useState(filesOn)
  const [filter, setFilter] = useState('all')
  const [progress, setProgress] = useState(null)
  const [applyError, setApplyError] = useState('')
  const busy = phase === 'applying' || phase === 'adding'
  const offersOn = filesOn && !!onAddOffers

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const groupByKey = useMemo(() => new Map(groups.map((g) => [g.key, g])), [groups])

// ── Цены и состояние строк ────────────────────────────────────────────────────────────────────────
  const vat = useMemo(() => {
    if (vatMode === 'auto') return result.vat
    const rate = Number(String(vatRate).replace(',', '.'))
    return { mode: vatMode, rate: Number.isFinite(rate) && rate >= 0 && rate < 100 ? rate : DEFAULT_VAT_RATE, force: true }
  }, [result, vatMode, vatRate])

  const priceOf = useCallback((item) => unitPriceWithVat(item, vat), [vat])
  const delivery = useMemo(() => deliveryFactor(result.items, priceOf), [result, priceOf])
  const factor = withDelivery ? delivery.factor : 1
  const fx = result.currency ? positiveNumber(fxRate) : 1

  const lines = useMemo(() => {
    return result.matches.map((m, i) => {
      // Цена в валюте: без курса цены нет, с курсом — в рублях.
      const raw = linePrice(m.item, vat, factor, deliveryOn)
      const base = fx ? packPrice(raw, fx === 1 ? null : 1 / fx) : { price: null, delivery: null, full: null }
      const picks = (choice[i] || []).map((key) => groupByKey.get(key)).filter(Boolean).map((group) => {
        const manual = positiveNumber(packEdits[`${i}:${group.key}`])
        const pack = manual ?? packOf(m.item, group)
        const priced = packPrice(base, pack === 1 ? null : pack)
        // Сейчас в расценке у позиций группы: своя другая цена — «заменит» (отмечает человек); цена из другого тендера —
        // «заменит цену из другого тендера»; пусто хотя бы где-то — «нет цены»; везде та же — «та же цена».
        const status = priced.price != null ? priceStatus(currentOf(group), priced.full) : null
        return { group, pack, manual: manual != null, ...priced, status, qtyFar: manual == null && packQtyFar(m.item, group, pack), unitOk: pack != null || groupUnitOk(m.item.unit, group), cand: m.candidates.find((c) => c.group.key === group.key) || null }
      })
      const main = picks[0] || null
      const shown = main || base
      return { i, item: m.item, candidates: m.candidates, base, raw, picks, group: main?.group || null, cand: main?.cand || null, pack: main?.pack ?? null,
        unitOk: picks.every((p) => p.unitOk), price: shown.price, deliveryUnit: shown.delivery, full: shown.full, delivery: m.item.delivery }
    })
  }, [result, choice, groupByKey, vat, factor, deliveryOn, currentOf, fx, packEdits])

  // Отметки по умолчанию — когда пришли сопоставления: позиция найдена, ед. изм. та же (или понятно, сколько её в
  // упаковке), цена есть, своя цена позиции не меняется (замену своей цены человек отмечает сам).
  const defaultsFor = useRef(null)
  useEffect(() => {
    if (defaultsFor.current === !!fx) return
    defaultsFor.current = !!fx
    setChecked(new Set(lines.filter((l) => l.group && l.unitOk && l.price != null && !l.item.sumOff && !l.picks.some((p) => p.status?.kind === 'replace' || p.qtyFar) && !l.delivery).map((l) => l.i)))
  }, [fx, lines])

  const goods = lines.filter((l) => !l.delivery)
  const matched = goods.filter((l) => l.group)
  const needsReview = (l) => !l.cand?.exact && !l.cand?.article
  const review = matched.filter(needsReview)
  const shown = goods.filter((l) => (filter === 'matched' ? !!l.group : filter === 'unmatched' ? !l.group : filter === 'review' ? l.group && needsReview(l) : true))
  const toApply = goods.filter((l) => checked.has(l.i) && l.group && l.price != null)
  const targetsCount = toApply.reduce((s, l) => s + l.picks.reduce((n, p) => n + p.group.targets.length, 0), 0)
  const deliveryLines = lines.filter((l) => l.delivery)
  // Какая строка документа держит позицию: выбрать её у другой строки — забрать (у прежней снимется).
  const takenBy = useMemo(() => {
    const m = new Map()
    choice.forEach((list, i) => { for (const k of list) m.set(k, i) })
    return m
  }, [choice])

  const toggle = useCallback((i, on) => setChecked((prev) => {
    const next = new Set(prev)
    if (on) next.add(i); else next.delete(i)
    return next
  }), [])
  // Позиция — одной строке документа: отметили занятую — у прежней строки она снимается. key = null — снять все.
  const choiceRef = useRef(choice)
  choiceRef.current = choice
  const pickGroup = useCallback((i, key, on = true) => {
    const next = choiceRef.current.map((list, j) => {
      if (j !== i) return on ? list.filter((k) => k !== key) : list
      if (key == null) return []
      return on ? [...list.filter((k) => k !== key), key] : list.filter((k) => k !== key)
    })
    setChoice(next)
    setTouched((prev) => new Set(prev).add(i))
    setChecked((prev) => {
      const out = new Set(prev)
      if (key != null && on) out.add(i)
      next.forEach((list, j) => { if (!list.length) out.delete(j) })
      return out
    })
  }, [])

  // Указал человек, сколько единиц позиции в единице документа: цена пересчиталась — строка отмечается.
  const editPack = useCallback((i, key, value) => {
    setPackEdits((prev) => ({ ...prev, [`${i}:${key}`]: value }))
    if (positiveNumber(value)) setChecked((prev) => new Set(prev).add(i))
  }, [])

  // Строки документа — как их хранит «в похожие цены»: выбранная в окне позиция (k) и «не сопоставлять» руками (x). Цена — за
  // единицу документа, в рублях (с курсом); без курса строки остаются в валюте и автовыбор их не берёт.
  const reviewNotes = () => offerNotes({
    source: result.kind,
    vat,
    delivery: factor,
    date: result.date,
    total: result.total,
    currency: result.currency && !fx ? result.currency : null,
    lines: goods.map((l) => ({
      name: l.item.name, unit: l.item.unit, qty: l.item.qty, code: l.item.code, price: fx ? l.base.full : l.raw.full, sumOff: l.item.sumOff, packQty: l.item.packQty,
      docPrice: docPriceOf(l.item), docVat: docVatOf(l.item), k: l.group?.k || null, also: l.picks.slice(1).map((p) => p.group.k),
      skip: !l.group && touched.has(l.i),
    })),
  })

  const apply = async () => {
    if (!toApply.length) return
    setApplyError('')
    setPhase('applying')
    setProgress({ done: 0, total: targetsCount })
    let res
    try {
      res = await onApply({ lines: toApply.flatMap((l) => l.picks.map((p) => ({ group: p.group, price: p.price, delivery: p.delivery }))), file, attach: filesOn && attach, notes: reviewNotes(), existing },
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
      await onAddOffers(file, reviewNotes(), existing)
      onOffersDone({ files: [file.name], lines: goods.filter((l) => l.full != null).length })
    } catch (e) {
      setApplyError(`Файл не добавлен в похожие цены: ${e.message || 'ошибка загрузки'}`)
      setPhase('review')
    }
  }

  // ── Отрисовка ─────────────────────────────────────────────────────────────────────────────────────
  const vatAuto = result.vat?.mode
  const vatCue = result.vat?.cue
  return (
    <div className="sp-modal-backdrop sp-modal-backdrop-full" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="sp-modal sp-modal-docimport is-full" role="dialog" aria-modal="true" aria-labelledby="sp-docimport-title">
        <h3 id="sp-docimport-title">Цены из счёта или КП поставщика</h3>
        <div className="sp-modal-body">
          <>
              {preset.attached > 0 && (
                <p className="sp-muted sp-di-attached" role="status">
                  Файл прикреплён {preset.attached === 1 ? 'к позиции' : `к позициям: ${preset.attached}`}. Ниже — цены из него: проверьте и примените.
                </p>
              )}
              {result.total && !result.total.ok && (
                <p className="sp-di-warn" role="alert">
                  <IconAlert size={16} /> Сумма прочитанных строк — {formatAmount(result.total.read)} ₽, а итог в документе — {formatAmount(result.total.doc)} ₽: часть строк могла не прочитаться, или в документе скидка на весь заказ.
                </p>
              )}
              {result.currency && (
                <p className="sp-di-warn" role="alert">
                  <IconAlert size={16} /> Цены в документе — в {result.currency}. Курс, ₽ за 1 {result.currency}:{' '}
                  <input type="text" inputMode="decimal" className="sp-di-rate" value={fxRate} onChange={(e) => setFxRate(e.target.value)} disabled={busy} aria-label={`Курс, ₽ за 1 ${result.currency}`} />
                  {!fx && ' без курса цены не применить.'}
                </p>
              )}
              <div className="sp-di-summary">
                <span className="sp-di-file"><PaperclipIcon size={14} /> {file.name}</span>
                <span className="sp-muted">
                  {result.kind === 'pdf' ? `PDF, страниц: ${result.pages}` : `лист «${result.sheetName}»`}
                  {' · '}строк с ценой: <b className="ui-num">{goods.length}</b>
                  {' · '}сопоставлено с ВОР: <b className="ui-num">{matched.length}</b>
                </span>
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
                      Доставка в документе: <b className="ui-num">{formatAmount(roundMoney(delivery.delivery))} ₽</b> — разнести по позициям
                      пропорционально сумме{delivery.factor > 1 ? ` (+${(Math.round((delivery.factor - 1) * 1000) / 10).toString().replace('.', ',')} %)` : ''}:
                      {deliveryOn ? ' в расценке — колонкой «Доставка» (за единицу), цена позиции — с доставкой' : ' в расценке цена «с доставкой»'}
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
                <span className="sp-muted sp-di-filter-hint">«Проверить» — сопоставлены по похожести, а не по тому же наименованию или артикулу</span>
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
                      <th className="ui-money" title={deliveryOn ? 'Цена за единицу с НДС и доставкой; доставка — колонкой «Доставка» расценки' : 'Цена за единицу с НДС и доставкой — как запишется в расценку'}>Цена в расценку, ₽</th>
                      <th>Позиция ВОР</th>
                      <th>Сейчас в расценке</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((l) => (
                      <DocLine key={l.i} line={l} checked={checked.has(l.i)} busy={busy} groups={groups} takenBy={takenBy}
                        onCheck={toggle} onPick={pickGroup} onPack={editPack} packEdits={packEdits} />
                    ))}
                    {!shown.length && <tr><td colSpan={5} className="no-data">Строк нет</td></tr>}
                  </tbody>
                </table>
              </div>
          </>
          {applyError && <p className="sp-error-text" role="alert">{applyError}</p>}
        </div>
        <div className="sp-modal-actions sp-di-actions">
          {filesOn && (
            <label className="sp-di-attach">
              <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} disabled={busy} />
              Прикрепить файл документом к позициям, получившим цену
            </label>
          )}
          {phase === 'applying' && progress && (
            <span className="sp-di-progress" role="status">Сохраняем цены: {progress.done} из {progress.total}…</span>
          )}
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Отмена</button>
          {offersOn && (
            <button type="button" className="btn-secondary" onClick={addOne} disabled={busy || !goods.some((l) => l.price != null)}
              title="Цены не пишутся: у позиций ВОР появятся цены этого документа — выбирать в таблице">
              {phase === 'adding' ? 'Добавляем…' : 'Только в похожие цены'}
            </button>
          )}
          <button type="button" className="btn-primary" onClick={apply} disabled={busy || !toApply.length}>
            {phase === 'applying' ? 'Применяем…' : `Применить цены: ${toApply.length}${targetsCount > toApply.length ? ` (позиций ВОР: ${targetsCount})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// Что сейчас в расценке у выбранных позиций строки: своя другая цена важнее всего.
function NowCell({ picks }) {
  if (!picks.some((p) => p.status)) return <span className="sp-muted">—</span>
  const replaced = [...new Set(picks.flatMap((p) => (p.status?.kind === 'replace' ? p.status.prices : [])))]
  if (replaced.length) return <span className="sp-di-tag is-warn">заменит {replaced.slice(0, 2).map((p) => formatAmount(p)).join(', ')}</span>
  if (picks.some((p) => p.status?.kind === 'copy')) return <span>заменит цену из другого тендера</span>
  if (picks.some((p) => p.status?.kind === 'new')) return <span>нет цены</span>
  return <span className="sp-muted">та же цена</span>
}

// Строка документа: отметка, наименование и цена из документа, цена в расценку, позиция ВОР (список выбора), что
// сейчас в расценке. Отметка в соседней строке её не перерисовывает.
const DocLine = memo(function DocLine({ line, checked, busy, groups, takenBy, onCheck, onPick, onPack, packEdits }) {
  const { item, group, full, deliveryUnit, pack, picks } = line
  const docPrice = docPriceOf(item)
  const vatTag = docVatOf(item) === 'net' ? 'без НДС' : docVatOf(item) === 'gross' ? 'с НДС' : ''
  return (
    <tr className={[!group && 'is-unmatched', checked && 'is-checked'].filter(Boolean).join(' ')}>
      <td className="sp-di-sel">
        <input type="checkbox" checked={checked} disabled={busy || !group || full == null} onChange={(e) => onCheck(line.i, e.target.checked)}
          aria-label={`Применить цену: ${item.name}`} />
      </td>
      <td className="sp-di-doc">
        <span className="sp-di-name">{item.name}</span>
        <span className="sp-di-meta">
          {item.code && <span>арт. {item.code}</span>}
          {item.qty != null && <span className="ui-num">{String(item.qty).replace('.', ',')} {item.unit || ''}</span>}
          {item.qty == null && item.unit && <span>{item.unit}</span>}
          {docPrice != null && <span className="ui-num">в документе {formatAmount(roundMoney(docPrice))}{vatTag ? ` ${vatTag}` : ''}</span>}
          {item.per && <span className="ui-num">в документе цена за {item.per}</span>}
          {item.source && <span>{item.source}</span>}
          {item.sumOff && <span className="sp-di-tag is-warn">цена × кол-во ≠ сумма — проверьте</span>}
        </span>
      </td>
      <td className="ui-money sp-di-price">
        {full != null ? formatAmount(full) : '—'}
        {pack != null && full != null && <span className="sp-di-meta">за {group.unit}</span>}
        {deliveryUnit != null && <span className="sp-di-meta ui-num">в т. ч. доставка {formatAmount(deliveryUnit)}</span>}
      </td>
      <td className="sp-di-pos">
        <PositionChoice line={line} groups={groups} takenBy={takenBy} busy={busy} onPick={onPick} onPack={onPack} packEdits={packEdits} />
      </td>
      <td className="sp-di-now">
        <NowCell picks={picks} />
      </td>
    </tr>
  )
})

// Позиции ВОР строки документа: «не сопоставлять» и сразу под ним самые похожие позиции, отметить можно несколько (цена
// встанет всем), «ещё N» — остальные кандидаты, поиск — среди всех позиций ВОР. Позиция другой строки — с пометкой:
// отметить её здесь — забрать. Цена за упаковку или бухту — подпись с пересчётом на единицу позиции.
function PositionChoice({ line, groups, takenBy, busy, onPick, onPack, packEdits }) {
  const [more, setMore] = useState(false)
  const [query, setQuery] = useState('')
  const { item, picks, candidates, base } = line
  const found = useMemo(() => (query.trim() ? searchGroups(query, groups, SEARCH_LIMIT) : null), [query, groups])
  const candOf = (g) => candidates.find((c) => c.group.key === g.key) || null
  let options = found
    ? found.map((g) => candOf(g) || { group: g, score: null, found: true })
    : (more ? candidates : candidates.slice(0, VISIBLE_OPTIONS))
  const picked = new Set(picks.map((p) => p.group.key))
  for (const { group } of [...picks].reverse()) {
    if (!options.some((c) => c.group.key === group.key)) options = [candOf(group) || { group, score: null, found: true }, ...options]
  }
  const hidden = found ? 0 : candidates.filter((c) => !options.includes(c)).length
  return (
    <div className="sp-di-choice" role="group" aria-label={`Позиция ВОР для «${item.name}»`}>
      <label className={`sp-di-opt is-none${!picks.length ? ' is-on' : ''}`}>
        <input type="checkbox" checked={!picks.length} disabled={busy || !picks.length} onChange={() => onPick(line.i, null)} />
        <span className="sp-di-opt-name">не сопоставлять</span>
      </label>
      {options.map((c) => {
        const on = picked.has(c.group.key)
        const other = takenBy.get(c.group.key)
        const editKey = `${line.i}:${c.group.key}`
        const manual = positiveNumber(packEdits?.[editKey])
        const pack = manual ?? packOf(item, c.group)
        const unitOk = pack != null || groupUnitOk(item.unit, c.group)
        // Ед. изм. другая, а сколько в единице документа, неизвестно, — можно указать.
        const askPack = on && item.unit && c.group.unit && (manual != null || !unitOk)
        return (
          <label key={c.group.key} className={`sp-di-opt${on ? ' is-on' : ''}`}>
            <input type="checkbox" checked={on} disabled={busy} onChange={(e) => onPick(line.i, c.group.key, e.target.checked)} />
            <span className="sp-di-opt-name">{c.group.name}</span>
            <span className="sp-di-opt-meta">
              <span>{unitText(c.group)}</span>
              {c.exact ? <span className="sp-di-tag is-exact"><IconCheck size={12} /> то же наименование</span>
                : c.code ? <span className="sp-di-tag is-exact">артикул совпал · {pct(c.score)}</span>
                  : c.score != null ? <span className="sp-di-tag">похоже на {pct(c.score)}{c.apart ? ' · числа другие' : ''}</span>
                    : <span className="sp-di-tag">найдено поиском</span>}
              {pack != null && !manual && base.full != null && (
                <span className="sp-di-tag">1 {item.unit} = {packText(pack)} {c.group.unit}: {formatAmount(packPrice(base, pack).full)} ₽ за {c.group.unit}</span>
              )}
              {!unitOk && <span className="sp-di-tag is-warn">ед. изм.: в документе «{item.unit}»</span>}
              {pack != null && !manual && packQtyFar(item, c.group, pack) && <span className="sp-di-tag is-warn">после пересчёта количество не похоже на объём ВОР</span>}
              {askPack && (
                <span className="sp-di-pack" onClick={(e) => e.preventDefault()}>
                  1 {item.unit} ={' '}
                  <input type="text" inputMode="decimal" className="sp-di-rate" value={packEdits?.[editKey] ?? ''} disabled={busy}
                    onChange={(e) => onPack(line.i, c.group.key, e.target.value)} aria-label={`Сколько ${c.group.unit} в 1 ${item.unit}: ${c.group.name}`} />
                  {' '}{c.group.unit}
                  {manual != null && base.full != null && <>: {formatAmount(packPrice(base, manual).full)} ₽ за {c.group.unit}</>}
                </span>
              )}
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
