import { useMemo, useRef, useState } from 'react'
import SupplyMoneyCell from '../supply/SupplyMoneyCell'
import VirtualTableBody from '../VirtualTableBody'
import { formatAmount, parseAmount } from '../../utils/money'
import { lineTotal } from '../../utils/bidVor'

// Список «Материалы» или «Работы» расценки подрядчика: уникальные позиции всех файлов ВОР тендера, цена за
// единицу с НДС и примечание. Длинный список — только видимые строки (как расценка снабжением).

const VIRTUAL_FROM = 150
const fmtVolume = (v) => (v == null ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 4 }))
const words = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean)

export default function BidPositionsTable({ kind, positions, rates, history, tenderNumbers, canEdit, docs, vatExempt = false, onCommit }) {
  const [query, setQuery] = useState('')
  const [onlyEmpty, setOnlyEmpty] = useState(false)
  const [doc, setDoc] = useState('')
  const scrollRef = useRef(null)

  const list = useMemo(() => {
    const q = words(query)
    return positions.filter((p) => {
      if (doc && !p.docs.includes(doc)) return false
      if (onlyEmpty && rates.get(p.key)?.price != null) return false
      if (!q.length) return true
      const name = p.name.toLowerCase().replace(/ё/g, 'е')
      return q.every((w) => name.includes(w))
    })
  }, [positions, rates, query, onlyEmpty, doc])

  const totals = useMemo(() => {
    let sum = 0
    let priced = 0
    for (const p of list) {
      const r = rates.get(p.key)
      if (r?.price == null) continue
      priced += 1
      sum += lineTotal(r.price, p.volume) || 0
    }
    return { sum: Math.round(sum * 100) / 100, priced }
  }, [list, rates])

  const noun = kind === 'material' ? 'материал' : 'работу'
  const renderRow = (i) => {
    const p = list[i]
    const r = rates.get(p.key)
    const price = r?.price ?? null
    const hist = price == null && history ? history.get(p.key) : null
    return (
      <tr key={p.key} className={price != null ? 'is-priced' : undefined}>
        <td className="bid-col-n">{i + 1}</td>
        <td className="bid-col-name">
          <span className="bid-name">{p.name}</span>
          {docs.length > 1 && <span className="bid-docs">ВОР: {p.docs.join(', ')}</span>}
          {hist && canEdit && (
            <span className="bid-hint">
              ваша цена{tenderNumbers?.get(hist.tender_id) ? ` в тендере № ${tenderNumbers.get(hist.tender_id)}` : ' в другом тендере'}:
              {' '}{formatAmount(hist.price)} ₽
              {' '}<button type="button" className="bid-link" onClick={() => onCommit(p, { price: hist.price, source: 'history' })}>подставить</button>
            </span>
          )}
        </td>
        <td className="bid-col-unit">{p.unit || '—'}</td>
        <td className="num bid-col-vol">{fmtVolume(p.volume)}</td>
        <td className="bid-col-price">
          <SupplyMoneyCell
            className="bid-money-input"
            value={price}
            disabled={!canEdit}
            cellId={`${kind}-${i}`}
            label={`Цена за единицу: ${p.name}`}
            placeholder={canEdit ? 'цена' : '—'}
            onCommit={(raw) => {
              const v = parseAmount(raw)
              onCommit(p, { price: v == null || v < 0 ? null : Math.round(v * 100) / 100, source: 'manual' })
            }}
          />
        </td>
        <td className="num bid-col-sum">{price != null && p.volume != null ? formatAmount(lineTotal(price, p.volume)) : '—'}</td>
        <td className="bid-col-note">
          <NoteInput value={r?.note || ''} disabled={!canEdit} label={`Примечание: ${p.name}`} onCommit={(note) => onCommit(p, { note })} />
        </td>
      </tr>
    )
  }

  if (!positions.length) {
    return <div className="bid-state">В файлах ВОР нет позиций этого вида.</div>
  }

  const big = list.length > VIRTUAL_FROM
  return (
    <div className="bid-table-block">
      <div className="bid-filters">
        <input type="search" className="bid-search" placeholder={`Найти ${noun}…`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Поиск по наименованию" />
        {docs.length > 1 && (
          <select className="bid-select" value={doc} onChange={(e) => setDoc(e.target.value)} aria-label="Файл ВОР">
            <option value="">Все ВОР ({docs.length})</option>
            {docs.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        <label className="bid-check">
          <input type="checkbox" checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)} /> только без цены
        </label>
        <span className="bid-filters-total">
          с ценой {totals.priced} из {list.length} · {formatAmount(totals.sum)} ₽
        </span>
      </div>
      <div className={`bid-table-wrap${big ? ' is-scroll' : ''}`} ref={scrollRef}>
        <table className="bid-table">
          <colgroup>
            <col className="bid-w-n" /><col /><col className="bid-w-unit" /><col className="bid-w-vol" />
            <col className="bid-w-price" /><col className="bid-w-sum" /><col className="bid-w-note" />
          </colgroup>
          <thead>
            <tr>
              <th className="bid-col-n">№</th>
              <th>Наименование</th>
              <th>Ед. изм.</th>
              <th className="num">Объём</th>
              <th className="num">{vatExempt ? 'Цена за ед. без НДС, ₽' : 'Цена за ед. с НДС, ₽'}</th>
              <th className="num">{vatExempt ? 'Сумма без НДС, ₽' : 'Сумма с НДС, ₽'}</th>
              <th>Примечание</th>
            </tr>
          </thead>
          {big ? (
            <VirtualTableBody rowCount={list.length} renderRow={renderRow} colSpan={7} scrollRef={scrollRef} rowHeight={44} />
          ) : (
            <tbody>{list.map((_, i) => renderRow(i))}</tbody>
          )}
        </table>
        {list.length === 0 && <div className="bid-state">Ничего не нашлось.</div>}
      </div>
    </div>
  )
}

// Примечание участника: пишется при уходе из поля, если изменилось.
function NoteInput({ value, disabled, label, onCommit }) {
  const [draft, setDraft] = useState(null)
  const cancel = useRef(false)
  const shown = draft ?? value
  return (
    <input
      type="text"
      className="bid-note-input"
      value={shown}
      disabled={disabled}
      maxLength={2000}
      placeholder={disabled ? '' : 'примечание'}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (!cancel.current && draft != null && draft.trim() !== value.trim()) onCommit(draft.trim())
        cancel.current = false
        setDraft(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') { cancel.current = true; e.currentTarget.blur() }
      }}
    />
  )
}
