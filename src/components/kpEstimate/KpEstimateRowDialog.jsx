// Окно строки сметы КП / ПЗ (13.11.2026 вместо панели справа): данные КП до перекидок и плана затрат одним блоком,
// уточнённый объём и причина, распределение — тендер (может не быть) и подрядчик, который его выиграл (подставляется из
// победителей тендера), и объём; примечание, заливка строки, история. Всё сохраняется само.
// Цена (27.11.2026): действующая — с изменениями администратора (своя, документом, пересчёт группой); администратор меняет
// её здесь же (у группы — сумму, состав пересчитывается пропорционально).
import { useEffect, useState } from 'react'
import {
  FILL_COLORS, STATUS_LABELS, allocQty, allocationText, fmtMoney, fmtQty, hasVolume, isPosition, originalQty, pairKey,
  parseQtyInput, round2, rowTotal, unitPrice,
} from '../../utils/kpEstimate'
import { describeLogEntry, fmtLogTime } from '../../utils/kpEstimateLog'
import { changePct, priceSourceText } from '../../utils/kpEstimatePrices'
import { Modal, SaveOnBlur, TenderContractorFields, qtyText } from './KpEstimateFields'

function Fact({ label, children, hint }) {
  return <div className="kpe-kv"><span className="kpe-kv-k" title={hint}>{label}</span><span className="kpe-kv-v">{children}</span></div>
}

// Новое распределение: тендер, подрядчик, объём (по умолчанию — весь свободный остаток).
function AddAllocation({ pickers, freeQty, unit, existing, onAdd }) {
  const [draft, setDraft] = useState({ tender_id: null, tender_label: null, counterparty_id: null, counterparty_name: null, qty: freeQty > 0 ? qtyText(freeQty) : '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setDraft((d) => ({ ...d, qty: freeQty > 0 ? qtyText(freeQty) : '' })) }, [freeQty])
  const submit = async () => {
    const qty = parseQtyInput(draft.qty)
    if (!draft.tender_id && !(draft.tender_label || '').trim() && !draft.counterparty_id && !(draft.counterparty_name || '').trim()) { setError('Укажите тендер или подрядчика'); return }
    if (!qty || Number.isNaN(qty) || qty < 0) { setError('Объём — положительное число'); return }
    if (existing.some((a) => pairKey(a) === pairKey(draft))) { setError('Этот тендер с этим подрядчиком у позиции уже есть — поправьте объём в его строке'); return }
    setBusy(true)
    setError('')
    const ok = await onAdd({
      tender_id: draft.tender_id || null, tender_label: draft.tender_label || null,
      counterparty_id: draft.counterparty_id || null, counterparty_name: draft.counterparty_name || null, pz_qty: qty,
    })
    setBusy(false)
    if (ok) setDraft({ tender_id: null, tender_label: null, counterparty_id: null, counterparty_name: null, qty: '' })
  }
  return (
    <div className="kpe-alloc-add">
      <div className="kpe-alloc-add-grid">
        <TenderContractorFields draft={draft} setDraft={setDraft} pickers={pickers} />
        <label className="kpe-f">Объём{unit ? `, ${unit}` : ''}
          <input className="kpe-field kpe-num" inputMode="decimal" aria-label="Объём" value={draft.qty}
            onChange={(e) => setDraft((d) => ({ ...d, qty: e.target.value }))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} />
        </label>
        <button type="button" className="kpe-btn kpe-btn--primary" disabled={busy || pickers?.loading} onClick={submit}>Добавить</button>
      </div>
      {error && <div className="kpe-error-line">{error}</div>}
    </div>
  )
}

export default function KpEstimateRowDialog({
  tree, rowId, marks, allocsByRow, states, sums, canEdit, pickers, onNeedPickers, onMark, onAllocInsert, onAllocUpdate,
  onAllocDelete, onClose, loadRowLog, logVersion, onPrevNext, effPrice = null, priceDoc = null, canPrice = false, onPrice = null,
}) {
  const row = tree.byId.get(rowId)
  const mark = marks.get(rowId)
  const allocs = allocsByRow.get(rowId) || []
  const state = states.get(rowId)
  const sum = sums.get(rowId)
  const [log, setLog] = useState(null)
  const [actualError, setActualError] = useState('')
  const [priceError, setPriceError] = useState('')

  useEffect(() => { setActualError(''); setPriceError('') }, [rowId])
  useEffect(() => {
    let alive = true
    setLog(null)
    loadRowLog(rowId).then((list) => { if (alive) setLog(list) }).catch(() => { if (alive) setLog([]) })
    return () => { alive = false }
  }, [rowId, logVersion, loadRowLog])
  useEffect(() => { if (canEdit && isPosition(row)) onNeedPickers() }, [canEdit, row, onNeedPickers])

  if (!row) return null
  const pos = isPosition(row)
  const k = row.kp || {}
  const p = row.pz
  // Деньги окна — по действующей цене (с изменениями администратора), как в таблице.
  const filePrice = unitPrice(row)
  const price = state?.price ?? effPrice?.unit ?? filePrice
  const orig = originalQty(row)
  const group = tree.children.has(rowId)
  // Как задаётся цена строки: позиция с «Кол-вом (ГП)» — за единицу, группа и позиция без кол-ва — суммой.
  const priceKind = group ? 'group_total' : pos && orig ? 'price' : pos ? 'group_total' : null
  const fileTotal = group ? (sum?.total ?? 0) : rowTotal(row)
  const ownKey = priceKind === 'price' ? 'unit_price' : 'total'
  const ownValue = effPrice?.own && effPrice.own[ownKey] !== null && effPrice.own[ownKey] !== undefined ? qtyText(round2(Number(effPrice.own[ownKey]))) : ''
  const pctOf = (next, prev) => {
    const v = changePct(next, prev)
    return v === null ? '' : `, ${v > 0 ? '+' : ''}${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`
  }
  const unit = row.unit || ''
  const parts = (list) => list.filter(([, v]) => v !== null && v !== undefined && v !== 0).map(([l, v]) => `${l} ${fmtMoney(v)}`).join(' · ')

  const title = (
    <span className="kpe-row-title">
      <span className="kpe-muted">{row.code || (row.pos_no ? `№ ${row.pos_no}` : '')}</span> {row.name}
    </span>
  )
  const nav = (
    <span className="kpe-detail-nav">
      <button type="button" className="kpe-icon-btn" aria-label="Предыдущая строка" title="Предыдущая строка" onClick={() => onPrevNext(-1)}>↑</button>
      <button type="button" className="kpe-icon-btn" aria-label="Следующая строка" title="Следующая строка" onClick={() => onPrevNext(1)}>↓</button>
    </span>
  )

  return (
    <Modal title={title} ariaLabel="Строка сметы" onClose={onClose} wide extra={nav} className="kpe-row-dialog">
      <section className="kpe-box">
        {row.unit ? (
          <>
            <Fact label="Кол-во (ГП)">{fmtQty(orig)} {unit}</Fact>
            {price ? <Fact label="Цена за ед.">{fmtMoney(price)} ₽ / {unit}</Fact> : null}
            <Fact label="Стоимость КП"><b>{fmtMoney(k.total ?? p?.comm_total)}</b>{!row.kp && <span className="kpe-muted"> (строка только плана затрат, в итог КП не входит)</span>}
              {(k.materials || k.works) ? <span className="kpe-muted"> ({parts([['материалы', k.materials], ['работы', k.works]])})</span> : null}</Fact>
            {p && <Fact label="Прямые затраты"><b>{fmtMoney(p.direct)}</b>
              {parts([['осн. материалы', p.direct_main], ['вспом.', p.direct_aux], ['работы', p.direct_works]]) && <span className="kpe-muted"> ({parts([['осн. материалы', p.direct_main], ['вспом.', p.direct_aux], ['работы', p.direct_works]])})</span>}
              {p.unpriced ? <span className="kpe-muted"> · известная часть: без цены {p.unpriced} из {p.resources} {p.resources % 10 === 1 && p.resources % 100 !== 11 ? 'ресурса' : 'ресурсов'}</span> : null}</Fact>}
            {p?.coef_total !== null && p?.coef_total !== undefined && (
              <Fact label="ПЗ × коэфф." hint="Прямые затраты известных ресурсов, умноженные на коэффициенты файла">{fmtMoney(p.coef_total)}</Fact>
            )}
          </>
        ) : sum ? (
          <>
            <Fact label="Стоимость КП"><b>{fmtMoney(sum.total)}</b></Fact>
            {sum.direct ? <Fact label="Прямые затраты"><b>{fmtMoney(sum.direct)}</b></Fact> : null}
            <Fact label="Позиций">{sum.positions}</Fact>
            <Fact label="Распределено">{fmtMoney(sum.distributedMoney)} ₽, свободно {fmtMoney(sum.freeMoney)} ₽{sum.counts.over ? <span className="kpe-over"> · превышение у {sum.counts.over} поз.</span> : null}</Fact>
          </>
        ) : null}
        {row.customer_note && <Fact label="Примечание заказчика">{row.customer_note}</Fact>}
        {row.gp_note && <Fact label="Примечание ГП">{row.gp_note}</Fact>}
        {p?.note && p.note !== row.gp_note && <Fact label="Примечание ПЗ">{p.note}</Fact>}
        {k.qty_basis === 'customer' && <Fact label="Объём" hint="Раскладка «Событие 6.2»: формула суммы строки умножает кол-во заказчика">по кол-ву заказчика — «Кол-во ГП» в файле пусто, сумма строки посчитана от кол-ва заказчика</Fact>}
        {k.psdc_ref && <Fact label="ПСДЦ">{k.psdc_ref}</Fact>}
      </section>

      {priceKind && (effPrice?.changed || effPrice?.own || canPrice) && (
        <section className="kpe-box">
          <h4>Цена</h4>
          {priceKind === 'price' && (
            <Fact label="Действующая за ед.">{fmtMoney(effPrice?.unit ?? filePrice)} ₽ / {unit}
              {effPrice?.changed && <span className="kpe-muted"> (в файле {fmtMoney(filePrice)}{pctOf(effPrice.unit, filePrice)})</span>}</Fact>
          )}
          <Fact label={group ? 'Сумма по действующим ценам' : 'Стоимость по действующей цене'}>{fmtMoney(effPrice ? effPrice.total : fileTotal)} ₽
            {effPrice?.changed && <span className="kpe-muted"> (в файле {fmtMoney(fileTotal)}{pctOf(effPrice.total, fileTotal)})</span>}</Fact>
          {effPrice?.unreached && <div className="kpe-warn">Заданная сумма {fmtMoney(effPrice.target)} ₽ не достигнута: позиции внутри со своей ценой дают {fmtMoney(effPrice.total)} ₽, пересчитывать нечего.</div>}
          {effPrice && (effPrice.own || effPrice.scaled) && (
            <Fact label="Откуда">{priceSourceText(effPrice)}{priceDoc ? ` — «${priceDoc.title}»${priceDoc.stage ? `, ${priceDoc.stage}` : ''}` : ''}
              {effPrice.own?.updated_by_name ? <span className="kpe-muted">; {effPrice.own.updated_by_name}, {fmtLogTime(effPrice.own.updated_at)}</span> : null}</Fact>
          )}
          {canPrice && onPrice && (
            <>
              <div className="kpe-vol-grid">
                <label className="kpe-f">{priceKind === 'price' ? `Новая цена за ед., ₽${unit ? ` / ${unit}` : ''}` : group ? 'Новая сумма, ₽' : 'Новая стоимость, ₽'}
                  <SaveOnBlur value={ownValue} label={priceKind === 'price' ? 'Новая цена за единицу' : 'Новая сумма'} inputMode="decimal" className="kpe-num"
                    placeholder={fmtMoney(priceKind === 'price' ? (effPrice?.unit ?? filePrice) : (effPrice ? effPrice.total : fileTotal))} invalid={!!priceError}
                    onSave={(v) => {
                      const n = parseQtyInput(v)
                      if (Number.isNaN(n)) { setPriceError('Цена — число'); return }
                      setPriceError('')
                      onPrice(rowId, priceKind, n)
                    }} />
                </label>
                {effPrice?.own && <button type="button" className="kpe-btn" onClick={() => onPrice(rowId, priceKind, null)}>Вернуть цену файла</button>}
              </div>
              {priceError && <div className="kpe-error-line">{priceError}</div>}
              {group && <p className="kpe-small kpe-muted">Позиции внутри пересчитаются пропорционально (уменьшатся или увеличатся). Позиции со своей ценой остаются как есть — остаток суммы делится на остальные.</p>}
            </>
          )}
        </section>
      )}

      {hasVolume(row) && (
        <section className="kpe-box">
          <h4>Объём</h4>
          <div className="kpe-vol-grid">
            <label className="kpe-f">Актуальный, {unit}
              <SaveOnBlur value={qtyText(mark?.actual_qty)} label="Актуальный объём" inputMode="decimal" disabled={!canEdit}
                placeholder={fmtQty(orig)} invalid={!!actualError} className="kpe-num"
                onSave={(v) => {
                  const n = parseQtyInput(v)
                  if (Number.isNaN(n) || (n !== null && n < 0)) { setActualError('Объём — неотрицательное число'); return }
                  setActualError('')
                  onMark(rowId, { actual_qty: n })
                }} />
            </label>
            <label className="kpe-f">Причина изменения
              <SaveOnBlur value={mark?.actual_reason || ''} label="Причина изменения объёма" disabled={!canEdit} maxLength={2000}
                placeholder="Например: пересчёт по РД, ведомость от 10.11" onSave={(v) => onMark(rowId, { actual_reason: v })} />
            </label>
          </div>
          {actualError && <div className="kpe-error-line">{actualError}</div>}
          {pos && state?.changed && <p className="kpe-small">Разница: <span className={state.diff > 0 ? 'kpe-up' : 'kpe-down'}>{state.diff > 0 ? '+' : ''}{fmtQty(state.diff)} {unit}</span> <span className="kpe-muted">({fmtMoney(state.diff * price)} ₽)</span></p>}
        </section>
      )}

      {pos && (
        <section className="kpe-box">
          <h4>Тендер и подрядчик</h4>
          <div className="kpe-dist-summary">
            <span>Распределено <b>{fmtQty(state?.distributed)}</b> из {fmtQty(state?.actual)} {unit}</span>
            <span className={state?.status === 'over' ? 'kpe-over' : ''}>свободно <b>{fmtQty(state?.free)}</b></span>
            {state && state.status !== 'empty' && <span className={`kpe-status kpe-status--${state.status}`}>{STATUS_LABELS[state.status]}</span>}
          </div>
          {state?.status === 'over' && <div className="kpe-warn">Распределено больше актуального объёма на {fmtQty(-state.free)} {unit}. Распределения сами не меняются — проверьте объёмы.</div>}
          {allocs.length > 0 && (
            <table className="kpe-alloc-table">
              <tbody>
                {allocs.map((a) => (
                  <tr key={a.id}>
                    <td className="kpe-alloc-who">{allocationText(a)}
                      {a.note && <div className="kpe-muted kpe-small">{a.note}</div>}
                      {a.contract_label && <div className="kpe-muted kpe-small">{a.contract_label}</div>}
                    </td>
                    <td className="kpe-alloc-qty">
                      <SaveOnBlur value={qtyText(allocQty(a))} label={`Объём: ${allocationText(a)}`} inputMode="decimal" disabled={!canEdit} className="kpe-num"
                        onSave={(v) => {
                          const n = parseQtyInput(v)
                          if (!n || Number.isNaN(n) || n < 0) return
                          onAllocUpdate(a, { pz_qty: n, ...(Number(a.contract_qty) ? { contract_qty: 0 } : {}) })
                        }} />
                    </td>
                    <td className="kpe-num kpe-muted">{price ? `${fmtMoney(allocQty(a) * price)} ₽` : ''}</td>
                    <td className="kpe-alloc-del">
                      {canEdit && <button type="button" className="kpe-icon-btn" aria-label={`Удалить: ${allocationText(a)}`} title="Удалить" onClick={() => onAllocDelete(a)}>✕</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!allocs.length && !canEdit && <p className="kpe-small kpe-muted">Объём ещё не распределён.</p>}
          {canEdit && <AddAllocation pickers={pickers} unit={unit} freeQty={state?.free > 0 ? state.free : 0} existing={allocs}
            onAdd={(payload) => onAllocInsert(rowId, payload)} />}
        </section>
      )}

      <section className="kpe-box">
        <h4>Примечание</h4>
        <SaveOnBlur multiline value={mark?.note || ''} label="Примечание к строке" disabled={!canEdit} maxLength={4000}
          placeholder="Видят все, кто работает со сметой" onSave={(v) => onMark(rowId, { note: v })} />
        <div className="kpe-fill-row">
          <span className="kpe-muted">Заливка строки</span>
          <span className="kpe-palette" role="group" aria-label="Заливка строки">
            {FILL_COLORS.map((c) => (
              <button key={c.key} type="button" className={`kpe-swatch${mark?.fill === c.key ? ' is-on' : ''}`} style={{ '--sw': c.key }}
                aria-label={c.label} title={c.label} disabled={!canEdit} onClick={() => onMark(rowId, { fill: mark?.fill === c.key ? null : c.key })} />
            ))}
            <button type="button" className="kpe-swatch kpe-swatch--none" aria-label="Без заливки" title="Без заливки" disabled={!canEdit || !mark?.fill}
              onClick={() => onMark(rowId, { fill: null })} />
          </span>
          {mark?.updated_by_name && <span className="kpe-muted kpe-small kpe-fill-by">Изменил(а): {mark.updated_by_name}, {fmtLogTime(mark.updated_at)}</span>}
        </div>
      </section>

      <details className="kpe-box kpe-row-log">
        <summary>История строки{log ? ` (${log.length})` : ''}</summary>
        {log === null ? <p className="kpe-small kpe-muted">Загрузка…</p> : !log.length ? <p className="kpe-small kpe-muted">Изменений не было.</p> : (
          <ul className="kpe-log">
            {log.map((e) => {
              const d = describeLogEntry(e)
              return (
                <li key={e.id}>
                  <div className="kpe-log-head"><b>{d.title}</b> <span className="kpe-muted">{e.changed_by_name || '—'} · {fmtLogTime(e.changed_at)}</span></div>
                  {d.lines.map((l, i) => <div key={i} className="kpe-log-line">{l}</div>)}
                </li>
              )
            })}
          </ul>
        )}
      </details>
    </Modal>
  )
}
