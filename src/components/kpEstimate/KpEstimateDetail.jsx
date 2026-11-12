// Подробности строки сметы КП / ПЗ (панель справа): данные КП и ПЗ с формулами, связь КП ↔ ПЗ, объёмы и причина,
// ответственный, примечание, заливка, распределение по тендерам и подрядчикам, история строки. Всё сохраняется само.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FILL_COLORS, STATUS_LABELS, fmtMoney, fmtQty, hasVolume, isPosition, linkedKpIds, linkedPzIds, originalQty,
  parseQtyInput, rowLabel, unitPrice,
} from '../../utils/kpEstimate'
import { describeLogEntry, fmtLogTime } from '../../utils/kpEstimateLog'

const qtyText = (v) => (v === null || v === undefined || v === '' ? '' : String(v).replace('.', ','))

// Поле, которое сохраняется при уходе из него (и по Enter у однострочного).
function SaveOnBlur({ value, onSave, multiline = false, placeholder, disabled, label, inputMode, maxLength, invalid }) {
  const [text, setText] = useState(value ?? '')
  const cancelRef = useRef(false)
  useEffect(() => { setText(value ?? '') }, [value])
  const commit = () => {
    if (cancelRef.current) { cancelRef.current = false; setText(value ?? ''); return }
    if ((text ?? '') !== (value ?? '')) onSave(text)
  }
  const props = {
    value: text, disabled, placeholder, 'aria-label': label, maxLength,
    className: `kpe-field${invalid ? ' is-invalid' : ''}`,
    onChange: (e) => setText(e.target.value),
    onBlur: commit,
    // Enter — сохранить (в многострочном перенос — Shift+Enter), Esc — отменить набранное.
    onKeyDown: (e) => {
      if (e.key === 'Escape') { cancelRef.current = true; e.currentTarget.blur() }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur() }
    },
  }
  return multiline ? <textarea rows={3} {...props} /> : <input inputMode={inputMode} {...props} />
}

// Выбор с поиском (подрядчик): список подходящих, своё название — тоже можно.
function SearchSelect({ value, options, onPick, placeholder, label, disabled }) {
  const [query, setQuery] = useState(value || '')
  const [open, setOpen] = useState(false)
  useEffect(() => { setQuery(value || '') }, [value])
  const tokens = query.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean)
  const list = useMemo(() => {
    if (!open) return []
    const out = []
    for (const o of options) {
      const hay = `${o.label} ${o.hint || ''}`.toLowerCase().replace(/ё/g, 'е')
      if (tokens.every((t) => hay.includes(t))) out.push(o)
      if (out.length >= 40) break
    }
    return out
  }, [open, options, tokens.join(' ')]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="kpe-search-select">
      <input className="kpe-field" value={query} placeholder={placeholder} aria-label={label} disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onBlur={() => setTimeout(() => {
          setOpen(false)
          if ((query || '') !== (value || '')) onPick({ id: null, label: query.trim() })
        }, 150)} />
      {open && list.length > 0 && (
        <ul className="kpe-options" role="listbox">
          {list.map((o) => (
            <li key={o.id || o.label} role="option" aria-selected={false}
              onMouseDown={(e) => { e.preventDefault(); setQuery(o.label); setOpen(false); onPick(o) }}>
              <span>{o.label}</span>{o.hint && <span className="kpe-muted"> {o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function tenderOptionLabel(t) {
  return `№ ${t.public_tender_number ?? '—'}${t.work_description ? ` — ${String(t.work_description).slice(0, 80)}` : ''}`
}
export const tenderLabel = (t) => `№ ${t.public_tender_number ?? '—'}`
const contractLabel = (c) => `${c.record_type === 'ds' ? 'ДС' : 'Договор'} № ${c.contract_number || c.display_id || '—'}${c.contract_date ? ` от ${new Date(c.contract_date).toLocaleDateString('ru-RU')}` : ''}`

// Строка распределения: тендер / объём в ПЗ / подрядчик / договор / закреплено / примечание.
function AllocationEditor({ alloc, pickers, canEdit, freeQty, onSave, onDelete, onCancel, isNew }) {
  const [draft, setDraft] = useState(() => ({ ...alloc }))
  const [manualTender, setManualTender] = useState(!!(alloc.tender_label && !alloc.tender_id))
  const [error, setError] = useState('')
  useEffect(() => { if (!isNew) setDraft({ ...alloc }) }, [alloc, isNew])

  const tenders = pickers?.tenders || []
  const winners = new Set((pickers?.winners || []).filter((w) => w.tender_id === draft.tender_id).map((w) => w.counterparty_id))
  const cpOptions = useMemo(() => {
    const list = (pickers?.counterparties || []).map((c) => ({ id: c.id, label: c.name, hint: [c.inn && `ИНН ${c.inn}`, winners.has(c.id) && 'победитель тендера'].filter(Boolean).join(' · ') }))
    return list.sort((a, b) => (winners.has(b.id) ? 1 : 0) - (winners.has(a.id) ? 1 : 0))
  }, [pickers, draft.tender_id]) // eslint-disable-line react-hooks/exhaustive-deps
  const contracts = (pickers?.contracts || []).filter((c) => !draft.counterparty_id || c.counterparty_id === draft.counterparty_id)

  const commit = (patch) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    setError('')
    if (isNew) return
    onSave(patch)
  }
  const qtyPatch = (key, text) => {
    const n = parseQtyInput(text)
    if (Number.isNaN(n) || (n !== null && n < 0)) { setError('Объём — неотрицательное число'); return null }
    return { [key]: n ?? 0 }
  }
  const valid = draft.tender_id || (draft.tender_label || '').trim() || draft.counterparty_id || (draft.counterparty_name || '').trim()

  return (
    <div className={`kpe-alloc${isNew ? ' is-new' : ''}`}>
      <div className="kpe-alloc-grid">
        <label>Тендер
          {manualTender || !tenders.length ? (
            <SaveOnBlur value={draft.tender_label || ''} label="Тендер (вручную)" placeholder="№ тендера или лот" disabled={!canEdit}
              onSave={(v) => commit({ tender_id: null, tender_label: v.trim() || null })} />
          ) : (
            <select className="kpe-field" value={draft.tender_id || ''} disabled={!canEdit} aria-label="Тендер"
              onChange={(e) => {
                if (e.target.value === '__manual') { setManualTender(true); return }
                const t = tenders.find((x) => x.id === e.target.value)
                const patch = { tender_id: t?.id || null, tender_label: t ? tenderLabel(t) : null }
                if (isNew && t && !Number(draft.pz_qty) && freeQty > 0) patch.pz_qty = freeQty
                commit(patch)
              }}>
              <option value="">— без тендера —</option>
              {tenders.map((t) => <option key={t.id} value={t.id}>{tenderOptionLabel(t)}</option>)}
              {draft.tender_id && !tenders.some((t) => t.id === draft.tender_id) && <option value={draft.tender_id}>{draft.tender_label || 'тендер'}</option>}
              <option value="__manual">Вручную…</option>
            </select>
          )}
        </label>
        <label>В расчёте ПЗ
          <SaveOnBlur value={qtyText(draft.pz_qty)} label="Объём в расчёте ПЗ" inputMode="decimal" disabled={!canEdit}
            onSave={(v) => { const p = qtyPatch('pz_qty', v); if (p) commit(p) }} />
        </label>
        <label>Подрядчик
          <SearchSelect value={draft.counterparty_name || ''} options={cpOptions} label="Подрядчик" placeholder="Название или ИНН" disabled={!canEdit}
            onPick={(o) => commit({ counterparty_id: o.id || null, counterparty_name: o.label || null, ...(o.id !== draft.counterparty_id ? { contract_id: null, contract_label: null } : {}) })} />
        </label>
        <label>Договор
          {contracts.length ? (
            <select className="kpe-field" value={draft.contract_id || ''} disabled={!canEdit} aria-label="Договор"
              onChange={(e) => {
                const c = contracts.find((x) => x.id === e.target.value)
                commit({ contract_id: c?.id || null, contract_label: c ? contractLabel(c) : null })
              }}>
              <option value="">— не указан —</option>
              {contracts.map((c) => <option key={c.id} value={c.id}>{contractLabel(c)}</option>)}
            </select>
          ) : (
            <SaveOnBlur value={draft.contract_label || ''} label="Договор (вручную)" placeholder="№ договора" disabled={!canEdit}
              onSave={(v) => commit({ contract_id: null, contract_label: v.trim() || null })} />
          )}
        </label>
        <label>Закреплено
          <SaveOnBlur value={qtyText(draft.contract_qty)} label="Закреплённый объём" inputMode="decimal" disabled={!canEdit}
            onSave={(v) => { const p = qtyPatch('contract_qty', v); if (p) commit(p) }} />
        </label>
        <label className="kpe-alloc-note">Примечание
          <SaveOnBlur value={draft.note || ''} label="Примечание к распределению" disabled={!canEdit} maxLength={2000}
            onSave={(v) => commit({ note: v.trim() || null })} />
        </label>
      </div>
      {error && <div className="kpe-error-line">{error}</div>}
      {canEdit && (
        <div className="kpe-alloc-actions">
          {isNew ? (
            <>
              <button type="button" className="kpe-btn kpe-btn--primary" disabled={!valid}
                title={valid ? undefined : 'Укажите тендер или подрядчика'}
                onClick={() => onSave({
                  tender_id: draft.tender_id || null, tender_label: draft.tender_label || null, pz_qty: Number(draft.pz_qty) || 0,
                  counterparty_id: draft.counterparty_id || null, counterparty_name: draft.counterparty_name || null,
                  contract_id: draft.contract_id || null, contract_label: draft.contract_label || null,
                  contract_qty: Number(draft.contract_qty) || 0, note: draft.note || null,
                })}>Добавить</button>
              <button type="button" className="kpe-btn" onClick={onCancel}>Отмена</button>
              {freeQty > 0 && <button type="button" className="kpe-btn kpe-btn--ghost" onClick={() => commit({ pz_qty: freeQty })}>Весь свободный остаток ({fmtQty(freeQty)})</button>}
            </>
          ) : (
            <>
              <span className="kpe-muted kpe-alloc-by">{alloc.updated_by_name || alloc.created_by_name || ''}{alloc.updated_at ? ` · ${fmtLogTime(alloc.updated_at)}` : ''}</span>
              <button type="button" className="kpe-btn kpe-btn--danger-ghost" onClick={() => onDelete(alloc)}>Удалить</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Field({ label, children, hint }) {
  return (
    <div className="kpe-kv"><span className="kpe-kv-k" title={hint}>{label}</span><span className="kpe-kv-v">{children}</span></div>
  )
}

export default function KpEstimateDetail({
  tree, rowId, view, marks, allocsByRow, states, sums, canEdit, pickers, employees, onNeedPickers, onMark, onAllocInsert,
  onAllocUpdate, onAllocDelete, onNavigate, onShow, onClose, loadRowLog, logVersion, onPrevNext,
}) {
  const row = tree.byId.get(rowId)
  const mark = marks.get(rowId)
  const allocs = allocsByRow.get(rowId) || []
  const state = states.get(rowId)
  const sum = sums.get(rowId)
  const [adding, setAdding] = useState(false)
  const [log, setLog] = useState(null)
  const [actualError, setActualError] = useState('')

  useEffect(() => { setAdding(false); setActualError('') }, [rowId])
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
  const pzLinks = linkedPzIds(tree, rowId).filter((id) => id !== rowId)
  const kpLinks = linkedKpIds(tree, rowId).filter((id) => id !== rowId)
  const parentAgg = kpLinks.length ? tree.byId.get(kpLinks[0]) : null
  const price = unitPrice(row)
  const orig = originalQty(row)
  const ratio = p?.direct ? (p.comm_total ?? k.total) / p.direct : null

  return (
    <aside className="kpe-detail" aria-label="Подробности строки">
      <header className="kpe-detail-head">
        <div className="kpe-detail-title">
          <span className="kpe-muted">{row.code || (row.pos_no ? `№ ${row.pos_no}` : '')}{row.kind === 'aggregate' ? ' · укрупнённая позиция' : ''}</span>
          <h3>{row.name}</h3>
        </div>
        <div className="kpe-detail-nav">
          <button type="button" className="kpe-icon-btn" aria-label="Предыдущая строка" onClick={() => onPrevNext(-1)}>↑</button>
          <button type="button" className="kpe-icon-btn" aria-label="Следующая строка" onClick={() => onPrevNext(1)}>↓</button>
          <button type="button" className="kpe-icon-btn" aria-label="Закрыть подробности" onClick={onClose}>✕</button>
        </div>
      </header>

      <div className="kpe-detail-body">
        <section className="kpe-box">
          <h4>Связь КП ↔ ПЗ</h4>
          <div className="kpe-link-row">
            <button type="button" className={`kpe-btn${view === 'kp' ? ' is-on' : ''}`} onClick={() => onShow(rowId, 'kp')}>Показать в КП</button>
            <button type="button" className={`kpe-btn${view === 'pz' ? ' is-on' : ''}`} disabled={!p && !pzLinks.length} onClick={() => onShow(rowId, 'pz')}>Показать в ПЗ</button>
          </div>
          {parentAgg && (
            <p className="kpe-small">Входит в укрупнённую позицию КП: <button type="button" className="kpe-text-btn" onClick={() => onNavigate(parentAgg.id)}>{rowLabel(parentAgg)}</button></p>
          )}
          {!p && pzLinks.length > 0 && (
            <div className="kpe-small">
              Подробные позиции ПЗ ({pzLinks.length}):
              <ul className="kpe-link-list">
                {pzLinks.slice(0, 30).map((id) => {
                  const r = tree.byId.get(id)
                  return <li key={id}><button type="button" className="kpe-text-btn" onClick={() => onNavigate(id)}>{rowLabel(r)}</button> <span className="kpe-muted">{fmtMoney(r.pz?.direct)} ₽</span></li>
                })}
                {pzLinks.length > 30 && <li className="kpe-muted">и ещё {pzLinks.length - 30}</li>}
              </ul>
            </div>
          )}
          {!p && !pzLinks.length && pos && <p className="kpe-small kpe-muted">Позиции нет в смете ПЗ (в КП она с нулевой стоимостью или учтена в другой строке).</p>}
        </section>

        {(row.unit || sum) && (
          <section className="kpe-box">
            <h4>КП до перекидок</h4>
            {row.unit && row.kind === 'aggregate' ? (
              <>
                <Field label="Кол-во заказчика">{fmtQty(k.qty_customer)} {row.unit}</Field>
                <Field label="Кол-во ГП">{fmtQty(k.qty_gp)} {row.unit}</Field>
                <Field label="Материалы" hint="Сумма подробных позиций (SUBTOTAL)">{fmtMoney(k.materials)}</Field>
                <Field label="Работы" hint="Сумма подробных позиций (SUBTOTAL)">{fmtMoney(k.works)}</Field>
                <Field label="Стоимость" hint="Сумма подробных позиций (SUBTOTAL)"><b>{fmtMoney(k.total)}</b></Field>
                <Field label="Состав">сумма подробных позиций ниже: {pzLinks.length} (SUBTOTAL)</Field>
                <Field label="За единицу">{fmtMoney(price)} ₽ / {row.unit}</Field>
              </>
            ) : row.unit ? (
              <>
                <Field label="Кол-во заказчика">{fmtQty(k.qty_customer)} {row.unit}</Field>
                <Field label="Кол-во ГП">{fmtQty(k.qty_gp)} {row.unit}</Field>
                {k.unit_materials !== null && k.unit_materials !== undefined && (
                  <Field label="Материалы" hint="Кол-во ГП × за единицу материалов">{fmtQty(k.qty_gp)} × {fmtMoney(k.unit_materials)} = <b>{fmtMoney(k.materials)}</b></Field>
                )}
                {k.unit_works !== null && k.unit_works !== undefined && (
                  <Field label="Работы" hint="Кол-во ГП × за единицу работ">{fmtQty(k.qty_gp)} × {fmtMoney(k.unit_works)} = <b>{fmtMoney(k.works)}</b></Field>
                )}
                <Field label="Стоимость" hint="Материалы + работы">{fmtMoney(k.materials)} + {fmtMoney(k.works)} = <b>{fmtMoney(k.total)}</b></Field>
                <Field label="За единицу">{fmtMoney(price)} ₽ / {row.unit}</Field>
                {k.base ? <Field label="Базовая стоимость">{fmtMoney(k.base)}</Field> : null}
              </>
            ) : (
              <>
                <Field label="Материалы">{fmtMoney(sum?.materials)}</Field>
                <Field label="Работы">{fmtMoney(sum?.works)}</Field>
                <Field label="Стоимость">{fmtMoney(sum?.total)}</Field>
                <Field label="Позиций">{sum?.positions || 0}</Field>
              </>
            )}
            {row.customer_note && <Field label="Примечание заказчика">{row.customer_note}</Field>}
            {row.gp_note && <Field label="Примечание ГП">{row.gp_note}</Field>}
          </section>
        )}

        {(p || (!pos && sum?.direct)) && (
          <section className="kpe-box">
            <h4>ПЗ: прямые затраты и коммерция</h4>
            {p ? (
              <>
                <Field label="Прямые затраты">{fmtMoney(p.direct_main)} + {fmtMoney(p.direct_aux)} + {fmtMoney(p.direct_works)} = <b>{fmtMoney(p.direct)}</b></Field>
                <Field label="Коммерция" hint="Материалы + работы после коэффициентов">{fmtMoney(p.comm_materials)} + {fmtMoney(p.comm_works)} = <b>{fmtMoney(p.comm_total)}</b></Field>
                <Field label="Цена за ед. коммерч." hint="Коммерция итого / Кол-во ГП">{fmtMoney(price)}</Field>
                {ratio ? <Field label="Коммерция / прямые">{ratio.toLocaleString('ru-RU', { maximumFractionDigits: 6 })}</Field> : null}
                {p.vat && <Field label="НДС">{p.vat}</Field>}
                {p.note && <Field label="Примечание ПЗ">{p.note}</Field>}
              </>
            ) : (
              <>
                <Field label="Прямые затраты">{fmtMoney(sum.direct)}</Field>
                <Field label="Коммерция итого">{fmtMoney(sum.commTotal)}</Field>
              </>
            )}
          </section>
        )}

        {hasVolume(row) && (
          <section className="kpe-box">
            <h4>Объём</h4>
            <Field label="Исходный">{fmtQty(orig)} {row.unit}</Field>
            <div className="kpe-kv"><span className="kpe-kv-k">Актуальный</span>
              <span className="kpe-kv-v">
                <SaveOnBlur value={qtyText(mark?.actual_qty)} label="Актуальный объём" inputMode="decimal" disabled={!canEdit}
                  placeholder={fmtQty(orig)} invalid={!!actualError}
                  onSave={(v) => {
                    const n = parseQtyInput(v)
                    if (Number.isNaN(n) || (n !== null && n < 0)) { setActualError('Объём — неотрицательное число'); return }
                    setActualError('')
                    onMark(rowId, { actual_qty: n })
                  }} />
              </span>
            </div>
            {actualError && <div className="kpe-error-line">{actualError}</div>}
            {pos && state?.changed && <Field label="Разница"><span className={state.diff > 0 ? 'kpe-up' : 'kpe-down'}>{state.diff > 0 ? '+' : ''}{fmtQty(state.diff)} {row.unit}</span> <span className="kpe-muted">({fmtMoney(state.diff * price)} ₽)</span></Field>}
            <div className="kpe-kv kpe-kv--block"><span className="kpe-kv-k">Причина изменения</span>
              <SaveOnBlur multiline value={mark?.actual_reason || ''} label="Причина изменения объёма" disabled={!canEdit} maxLength={2000}
                placeholder="Например: пересчёт по РД, ведомость от 10.11" onSave={(v) => onMark(rowId, { actual_reason: v })} />
            </div>
            {pos && <p className="kpe-small kpe-muted">Изменение актуального объёма не меняет тендеры и договоры: если распределено больше, строка подсветится.</p>}
          </section>
        )}

        <section className="kpe-box">
          <h4>Отметки</h4>
          <div className="kpe-kv"><span className="kpe-kv-k">Ответственный</span>
            <span className="kpe-kv-v">
              <select className="kpe-field" value={mark?.responsible_id || (mark?.responsible_name ? '__name' : '')} disabled={!canEdit} aria-label="Ответственный экономист"
                onFocus={() => onNeedPickers()}
                onChange={(e) => {
                  const emp = (employees || []).find((x) => x.user_id === e.target.value)
                  onMark(rowId, { responsible_id: emp?.user_id || null, responsible_name: emp ? (emp.display_name || emp.full_name || emp.email) : null })
                }}>
                <option value="">— не назначен —</option>
                {mark?.responsible_name && !mark?.responsible_id && <option value="__name">{mark.responsible_name}</option>}
                {mark?.responsible_id && !(employees || []).some((x) => x.user_id === mark.responsible_id) && <option value={mark.responsible_id}>{mark.responsible_name || 'сотрудник'}</option>}
                {(employees || []).map((emp) => <option key={emp.user_id} value={emp.user_id}>{emp.display_name || emp.full_name || emp.email}{emp.isEconomist ? ' — экономист' : ''}</option>)}
              </select>
            </span>
          </div>
          <div className="kpe-kv kpe-kv--block"><span className="kpe-kv-k">Примечание</span>
            <SaveOnBlur multiline value={mark?.note || ''} label="Примечание к строке" disabled={!canEdit} maxLength={4000}
              placeholder="Видят все, кто работает со сметой" onSave={(v) => onMark(rowId, { note: v })} />
          </div>
          <div className="kpe-kv"><span className="kpe-kv-k">Заливка строки</span>
            <span className="kpe-kv-v kpe-palette" role="group" aria-label="Заливка строки">
              {FILL_COLORS.map((c) => (
                <button key={c.key} type="button" className={`kpe-swatch${mark?.fill === c.key ? ' is-on' : ''}`} style={{ '--sw': c.key }}
                  aria-label={c.label} title={c.label} disabled={!canEdit} onClick={() => onMark(rowId, { fill: mark?.fill === c.key ? null : c.key })} />
              ))}
              <button type="button" className="kpe-swatch kpe-swatch--none" aria-label="Без заливки" title="Без заливки" disabled={!canEdit || !mark?.fill}
                onClick={() => onMark(rowId, { fill: null })} />
            </span>
          </div>
          {mark?.updated_by_name && <p className="kpe-small kpe-muted">Изменил(а): {mark.updated_by_name}, {fmtLogTime(mark.updated_at)}</p>}
        </section>

        {pos && (
          <section className="kpe-box">
            <h4>Распределение объёма</h4>
            <div className="kpe-dist-summary">
              <span>Актуальный: <b>{fmtQty(state?.actual)}</b></span>
              <span>Распределено: <b>{fmtQty(state?.distributed)}</b></span>
              <span className={state?.status === 'over' ? 'kpe-over' : ''}>Свободно: <b>{fmtQty(state?.free)}</b></span>
              {state && <span className={`kpe-status kpe-status--${state.status}`}>{STATUS_LABELS[state.status]}</span>}
            </div>
            {state?.status === 'over' && (
              <div className="kpe-warn">Распределено больше актуального объёма на {fmtQty(-state.free)} {row.unit}. Договоры и тендеры сами не меняются — проверьте объёмы.</div>
            )}
            {(state?.groups || []).filter((g) => g.contractOver).map((g) => (
              <div key={g.key} className="kpe-warn">{g.tender_label || 'Тендер'}: по договорам закреплено {fmtQty(g.contractQty)} — больше, чем взято в расчёт ПЗ ({fmtQty(g.pzQty)}).</div>
            ))}
            <p className="kpe-small kpe-muted">Объём тендера и договоры по нему — один и тот же объём: в распределённом он учитывается один раз, по большему из двух.</p>
            {allocs.map((a) => (
              <AllocationEditor key={a.id} alloc={a} pickers={pickers} canEdit={canEdit} freeQty={state?.free > 0 ? state.free : 0}
                onSave={(patch) => onAllocUpdate(a, patch)} onDelete={onAllocDelete} />
            ))}
            {!allocs.length && !adding && <p className="kpe-small kpe-muted">Объём ещё не распределён.</p>}
            {adding && (
              <AllocationEditor isNew alloc={{ pz_qty: 0, contract_qty: 0 }} pickers={pickers} canEdit={canEdit} freeQty={state?.free > 0 ? state.free : 0}
                onSave={async (payload) => { if (await onAllocInsert(rowId, payload)) setAdding(false) }} onCancel={() => setAdding(false)} />
            )}
            {canEdit && !adding && <button type="button" className="kpe-btn" onClick={() => { onNeedPickers(); setAdding(true) }}>+ Добавить распределение</button>}
          </section>
        )}

        <section className="kpe-box">
          <h4>История строки</h4>
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
        </section>
      </div>
    </aside>
  )
}
