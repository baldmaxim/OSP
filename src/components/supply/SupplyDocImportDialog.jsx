import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconUpload } from '../icons/BsmIcons'
import { IconAlert, IconCheck } from '../icons/ActionIcons'
import { IconSearch } from '../icons/ToolbarIcons'
import PaperclipIcon from '../icons/PaperclipIcon'
import { formatAmount, roundMoney } from '../../utils/money'
import { DEFAULT_VAT_RATE, unitPriceWithVat } from '../../utils/supplierDoc'
import { SUPPLIER_DOC_ACCEPT, isPdfFile, isSheetFile, readSupplierDoc } from '../../utils/supplierDocRead'
import { deliveryFactor, groupUnitOk, matchDocItems, searchGroups } from '../../utils/supplyDocMatch'

// Больше — не распознаём (страница подвисла бы на разборе); прикрепить такой файл можно в колонке «Документ».
const PARSE_MAX_BYTES = 30 * 1024 * 1024

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

// Распознавание счёта / КП / УПД поставщика (Excel или PDF): строки документа сопоставляются с позициями ВОР тендера
// (точно — по наименованию, иначе — по похожести), человек проверяет и правит сопоставление, выбирает, считать ли
// цены с НДС и разносить ли доставку, и применяет: цены пишутся в расценку (как ввод руками), файл — документом к
// позициям, получившим цену. groups — позиции ВОР, сложенные в одинаковые (utils/supplyDocMatch.positionGroups).
// currentOf(group) — что сейчас в расценке: { own: [цены], copies, empty }. onApply({ lines, file, attach },
// onProgress) — записать; ответ { error } оставляет окно открытым.
export default function SupplyDocImportDialog({ groups, currentOf, filesOn, onApply, onClose }) {
  const [phase, setPhase] = useState('pick') // pick | reading | review | applying
  const [file, setFile] = useState(null)
  const [readError, setReadError] = useState('')
  const [result, setResult] = useState(null)
  const [choice, setChoice] = useState([]) // по строке документа: ключ группы или null
  const [checked, setChecked] = useState(() => new Set())
  const [vatMode, setVatMode] = useState('auto')
  const [vatRate, setVatRate] = useState(String(DEFAULT_VAT_RATE))
  const [withDelivery, setWithDelivery] = useState(true)
  const [attach, setAttach] = useState(filesOn)
  const [filter, setFilter] = useState('all')
  const [searchAt, setSearchAt] = useState(null)
  const [query, setQuery] = useState('')
  const [progress, setProgress] = useState(null)
  const [applyError, setApplyError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef(null)
  const busy = phase === 'reading' || phase === 'applying'

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const groupByKey = useMemo(() => new Map(groups.map((g) => [g.key, g])), [groups])

  // ── Чтение и сопоставление ────────────────────────────────────────────────────────────────────────
  const read = async (f) => {
    if (!f) return
    setFile(f)
    setReadError('')
    setResult(null)
    if (!isPdfFile(f.name) && !isSheetFile(f.name)) { setReadError(READ_ERROR.unsupported()); return }
    if (f.size > PARSE_MAX_BYTES) { setReadError(READ_ERROR.big()); return }
    setPhase('reading')
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      const r = await readSupplierDoc(bytes, f.name)
      if (r.error) {
        setReadError((READ_ERROR[r.error] || READ_ERROR.broken)(r, f.name))
        setPhase('pick')
        return
      }
      // Доставка — не позиция ВОР: не сопоставляется (и не забирает позицию у строки с материалом).
      const goodsMatches = matchDocItems(r.items.filter((it) => !it.delivery), groups)
      let k = 0
      const matches = r.items.map((item) => (item.delivery ? { item, match: null, candidates: [] } : goodsMatches[k++]))
      setResult({ ...r, matches })
      setChoice(matches.map((m) => m.match?.group.key || null))
      setVatMode('auto')
      setVatRate(String(r.vat?.rate ?? DEFAULT_VAT_RATE))
      setPhase('review')
    } catch (e) {
      setReadError(READ_ERROR.broken({ message: e.message }, f.name))
      setPhase('pick')
    }
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
      return { i, item: m.item, group, cand, unitOk, price, status, delivery: m.item.delivery }
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
  const shown = goods.filter((l) => (filter === 'matched' ? !!l.group : filter === 'unmatched' ? !l.group : true))
  const toApply = goods.filter((l) => checked.has(l.i) && l.group && l.price != null)
  const targetsCount = toApply.reduce((s, l) => s + l.group.targets.length, 0)
  const deliveryLines = lines.filter((l) => l.delivery)

  const toggle = (i, on) => setChecked((prev) => {
    const next = new Set(prev)
    if (on) next.add(i); else next.delete(i)
    return next
  })
  // Позиция — одной строке документа: выбрали занятую — у прежней строки сопоставление снимается.
  const pickGroup = (i, key) => {
    setChoice((prev) => prev.map((k, j) => (j === i ? key : key && k === key ? null : k)))
    setChecked((prev) => {
      const next = new Set(prev)
      if (key) next.add(i); else next.delete(i)
      choice.forEach((k, j) => { if (j !== i && key && k === key) next.delete(j) })
      return next
    })
    setSearchAt(null)
    setQuery('')
  }
  const found = useMemo(() => (searchAt == null ? [] : searchGroups(query, groups)), [searchAt, query, groups])

  const apply = async () => {
    if (!toApply.length) return
    setApplyError('')
    setPhase('applying')
    setProgress({ done: 0, total: targetsCount })
    let res
    try {
      res = await onApply({ lines: toApply.map((l) => ({ group: l.group, price: l.price })), file, attach: filesOn && attach },
        (done, total) => setProgress({ done, total }))
    } catch (e) {
      res = { error: e.message || 'Цены не записаны' }
    }
    if (res?.error) {
      setApplyError(res.error)
      setPhase('review')
    }
  }

  // ── Отрисовка ─────────────────────────────────────────────────────────────────────────────────────
  const vatAuto = result?.vat?.mode
  const vatCue = result?.vat?.cue
  return (
    <div className="sp-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="sp-modal sp-modal-docimport" role="dialog" aria-modal="true" aria-labelledby="sp-docimport-title">
        <h3 id="sp-docimport-title">Цены из счёта или КП поставщика</h3>
        <div className="sp-modal-body">
          {phase !== 'review' && phase !== 'applying' && (
            <>
              <p className="sp-muted">
                Загрузите счёт, КП или УПД поставщика в Excel или PDF: строки с ценами сопоставятся с позициями ВОР тендера —
                проверьте сопоставление и примените. Файл прикрепится документом к позициям, получившим цену.
              </p>
              <div
                className={`sp-drop${dragOver ? ' is-over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!busy) read(e.dataTransfer.files?.[0]) }}
              >
                <input ref={fileRef} type="file" accept={SUPPLIER_DOC_ACCEPT} hidden onChange={(e) => { read(e.target.files?.[0]); e.target.value = '' }} />
                <button type="button" className="btn-primary" onClick={() => fileRef.current?.click()} disabled={busy}>
                  <IconUpload size={16} /> Выбрать файл
                </button>
                <span className="sp-muted">или перетащите сюда · Excel (.xlsx, .xls, .csv) или PDF</span>
              </div>
              {phase === 'reading' && <p className="sp-drop-status" role="status">Распознаём «{file?.name}»…</p>}
              {readError && (
                <p className="sp-error-text sp-drop-status" role="alert"><IconAlert size={16} /> {file ? `«${file.name}»: ` : ''}{readError}</p>
              )}
            </>
          )}

          {(phase === 'review' || phase === 'applying') && result && (
            <>
              <div className="sp-di-summary">
                <span className="sp-di-file"><PaperclipIcon size={14} /> {file.name}</span>
                <span className="sp-muted">
                  {result.kind === 'pdf' ? `PDF, страниц: ${result.pages}` : `лист «${result.sheetName}»`}
                  {' · '}строк с ценой: <b className="ui-num">{goods.length}</b>
                  {' · '}сопоставлено с ВОР: <b className="ui-num">{matched.length}</b>
                </span>
                <button type="button" className="sp-link-btn" onClick={() => { setPhase('pick'); setResult(null); setFile(null) }} disabled={busy}>другой файл</button>
              </div>

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

              <div className="sp-filter" role="group" aria-label="Показать строки документа">
                {[['all', `Все (${goods.length})`], ['matched', `Сопоставлены (${matched.length})`], ['unmatched', `Без позиции (${goods.length - matched.length})`]].map(([k, label]) => (
                  <button key={k} type="button" className={`sp-filter-btn${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
                ))}
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
                      <DocLine key={l.i} line={l} candidates={result.matches[l.i].candidates} checked={checked.has(l.i)} busy={busy}
                        onCheck={(on) => toggle(l.i, on)} onPick={(key) => pickGroup(l.i, key)}
                        searching={searchAt === l.i} onSearch={() => { setSearchAt(l.i); setQuery(l.item.name) }}
                        query={query} setQuery={setQuery} found={found} onSearchClose={() => setSearchAt(null)} />
                    ))}
                    {!shown.length && <tr><td colSpan={5} className="no-data">Строк нет</td></tr>}
                  </tbody>
                </table>
              </div>
              {applyError && <p className="sp-error-text" role="alert">{applyError}</p>}
            </>
          )}
        </div>
        <div className="sp-modal-actions sp-di-actions">
          {(phase === 'review' || phase === 'applying') && filesOn && (
            <label className="sp-di-attach">
              <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} disabled={busy} />
              Прикрепить файл документом к позициям, получившим цену
            </label>
          )}
          {phase === 'applying' && progress && (
            <span className="sp-di-progress" role="status">Сохраняем цены: {progress.done} из {progress.total}…</span>
          )}
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Отмена</button>
          {(phase === 'review' || phase === 'applying') && (
            <button type="button" className="btn-primary" onClick={apply} disabled={busy || !toApply.length}>
              {phase === 'applying' ? 'Применяем…' : `Применить цены: ${toApply.length}${targetsCount > toApply.length ? ` (позиций ВОР: ${targetsCount})` : ''}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// Строка документа: отметка, наименование и цена из документа, цена в расценку, позиция ВОР (кандидаты, «нет»,
// поиск другой), что сейчас в расценке.
function DocLine({ line, candidates, checked, busy, onCheck, onPick, searching, onSearch, query, setQuery, found, onSearchClose }) {
  const { item, group, cand, unitOk, price, status } = line
  const docPrice = item.price ?? (item.sum != null && item.qty > 0 ? item.sum / item.qty : null)
  const vatTag = (item.price != null ? item.priceVat : item.sumVat) === 'net' ? 'без НДС' : (item.price != null ? item.priceVat : item.sumVat) === 'gross' ? 'с НДС' : ''
  const options = [...candidates]
  if (group && !options.some((c) => c.group.key === group.key)) options.unshift({ group, score: null, exact: false })
  const selectId = `sp-di-pos-${line.i}`
  return (
    <tr className={[!group && 'is-unmatched', checked && 'is-checked'].filter(Boolean).join(' ')}>
      <td className="sp-di-sel">
        <input type="checkbox" checked={checked} disabled={busy || !group || price == null} onChange={(e) => onCheck(e.target.checked)}
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
        {searching ? (
          <div className="sp-di-search">
            <label className="ui-search">
              <IconSearch size={16} />
              <input type="search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск позиции ВОР"
                aria-label={`Поиск позиции ВОР для «${item.name}»`} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onSearchClose() } }} />
            </label>
            <ul className="sp-di-found">
              {found.map((g) => (
                <li key={g.key}>
                  <button type="button" className="sp-link-btn" onClick={() => onPick(g.key)}>
                    {g.name} <span className="sp-muted">· {g.unit || (g.units || []).join(', ') || '—'}</span>
                  </button>
                </li>
              ))}
              {!found.length && <li className="sp-muted">Ничего не нашли</li>}
            </ul>
            <button type="button" className="sp-link-btn" onClick={onSearchClose}>закрыть поиск</button>
          </div>
        ) : (
          <>
            <select id={selectId} value={group?.key || ''} disabled={busy}
              onChange={(e) => (e.target.value === '__search' ? onSearch() : onPick(e.target.value || null))}
              aria-label={`Позиция ВОР для «${item.name}»`}>
              <option value="">— не сопоставлять —</option>
              {options.map((c) => (
                <option key={c.group.key} value={c.group.key}>
                  {c.group.name} · {c.group.unit || (c.group.units || []).join(', ') || '—'}{c.exact ? ' · точно' : c.score != null ? ` · ${pct(c.score)}` : ''}
                </option>
              ))}
              <option value="__search">Найти другую позицию…</option>
            </select>
            {group && (
              <span className="sp-di-match">
                {cand?.exact ? <span className="sp-di-tag is-exact"><IconCheck size={12} /> то же наименование</span>
                  : cand?.score != null ? <span className="sp-di-tag">похоже на {pct(cand.score)}{cand.sameNums ? '' : ' · размеры не совпали'}</span>
                    : <span className="sp-di-tag">выбрано вручную</span>}
                {!unitOk && <span className="sp-di-tag is-warn">ед. изм.: в документе «{item.unit}», в ВОР «{group.unit || (group.units || []).join(', ')}»</span>}
                {group.targets.length > 1 && <span className="sp-muted">в {group.targets.length} ВОР</span>}
              </span>
            )}
          </>
        )}
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
}
