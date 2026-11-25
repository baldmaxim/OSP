import { useMemo, useRef, useState } from 'react'
import SupplyMoneyCell from '../supply/SupplyMoneyCell'
import VirtualTableBody from '../VirtualTableBody'
import { formatAmount, parseAmount } from '../../utils/money'
import { lineTotal } from '../../utils/bidPrice'

// Список «Материалы» или «Работы» расценки подрядчика: уникальные позиции ведомостей тендера, цена за единицу с НДС и примечание.
// Решения пользователя 24.11.2026: не расценённая позиция — жёлтым (как «Сравнение КП»); ведомость выбрана — объём и сумма по ней;
// что изменилось в новой версии ВОР — отметкой в строке («новая», «было …»), как в расценке снабжения; разрешены цены снабжения —
// колонка «Цена СУ-10» с кнопкой «взять». Длинный список — только видимые строки (как расценка снабжением).

const VIRTUAL_FROM = 150
const fmtVolume = (v) => (v == null ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 4 }))
const words = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean)

// Изменения позиции по ведомостям: [{ id, title, op, oldVolume, oldUnit }] — только выбранной ведомости, если она выбрана.
function changesOf(p, changes, vorId, titleOf) {
  if (!changes?.size) return []
  const out = []
  for (const id of vorId ? [vorId] : p.files) {
    const c = changes.get(id)?.byKey.get(p.key)
    if (c) out.push({ id, title: titleOf.get(id) || '', ...c })
  }
  return out
}

function ChangeMark({ c, withTitle, unit }) {
  const where = withTitle && c.title ? ` в «${c.title}»` : ''
  if (c.op === 'added') return <span className="bid-change is-added">новая{where}</span>
  if (c.op === 'unit') {
    return <span className="bid-change">ед. изм.{where}: было {c.oldUnit || '—'}{c.oldVolume != null ? `, ${fmtVolume(c.oldVolume)}` : ''}</span>
  }
  return <span className="bid-change">объём{where}: было {fmtVolume(c.oldVolume)}{unit ? ` ${unit}` : ''}</span>
}

export default function BidPositionsTable({
  kind, positions, rates, history, tenderNumbers, canEdit, vors, vorId = '', onVorChange, titleOf, changes = null,
  supply = null, onTakeSupply, supplyBusy = false, vatExempt = false, onCommit,
}) {
  const [query, setQuery] = useState('')
  const [onlyEmpty, setOnlyEmpty] = useState(false)
  const [onlyChanged, setOnlyChanged] = useState(false)
  const scrollRef = useRef(null)
  const multi = vors.length > 1
  const hasChanges = !!changes?.size && positions.some((p) => changesOf(p, changes, vorId, titleOf).length)
  const showSupply = kind === 'material' && !!supply

  const list = useMemo(() => {
    const q = words(query)
    return positions.filter((p) => {
      if (vorId && !p.files.includes(vorId)) return false
      if (onlyEmpty && rates.get(p.key)?.price != null) return false
      if (onlyChanged && !changesOf(p, changes, vorId, titleOf).length) return false
      if (!q.length) return true
      const name = p.name.toLowerCase().replace(/ё/g, 'е')
      return q.every((w) => name.includes(w))
    })
  }, [positions, rates, query, onlyEmpty, onlyChanged, vorId, changes, titleOf])

  const volumeOf = (p) => (vorId ? p.vols[vorId] ?? null : p.volume)

  const totals = useMemo(() => {
    let sum = 0
    let priced = 0
    for (const p of list) {
      const r = rates.get(p.key)
      if (r?.price == null) continue
      priced += 1
      sum += lineTotal(r.price, vorId ? p.vols[vorId] : p.volume) || 0
    }
    return { sum: Math.round(sum * 100) / 100, priced }
  }, [list, rates, vorId])

  const noun = kind === 'material' ? 'материал' : 'работу'
  const renderRow = (i) => {
    const p = list[i]
    const r = rates.get(p.key)
    const price = r?.price ?? null
    const volume = volumeOf(p)
    const hist = price == null && history ? history.get(p.key) : null
    const marks = changesOf(p, changes, vorId, titleOf)
    const sp = showSupply ? supply.get(p.key) ?? null : null
    const fromSupply = price != null && r?.source === 'supply'
    return (
      <tr key={p.key} className={price != null ? 'is-priced' : 'is-unpriced'}>
        <td className="bid-col-n">{i + 1}</td>
        <td className="bid-col-name">
          <span className="bid-name">{p.name}</span>
          {multi && !vorId && <span className="bid-docs">ВОР: {p.files.map((id) => titleOf.get(id)).filter(Boolean).join(', ')}</span>}
          {marks.map((c) => <ChangeMark key={c.id} c={c} withTitle={multi && !vorId} unit={p.unit} />)}
          {hist && canEdit && (
            <span className="bid-hint">
              ваша цена{tenderNumbers?.get(hist.tender_id) ? ` в тендере № ${tenderNumbers.get(hist.tender_id)}` : ' в другом тендере'}:
              {' '}{formatAmount(hist.price)} ₽
              {' '}<button type="button" className="bid-link" onClick={() => onCommit(p, { price: hist.price, source: 'history' })}>подставить</button>
            </span>
          )}
        </td>
        <td className="bid-col-unit">{p.unit || '—'}</td>
        <td className="num bid-col-vol">{fmtVolume(volume)}</td>
        {showSupply && (
          <td className="num bid-col-supply">
            {sp == null ? <span className="bid-muted-cell">—</span> : (
              <>
                <span>{formatAmount(sp)}</span>
                {canEdit && !(fromSupply && price === sp) && (
                  <button type="button" className="bid-link bid-take" disabled={supplyBusy}
                    aria-label={`Взять цену снабжения ${formatAmount(sp)} ₽: ${p.name}`} onClick={() => onTakeSupply(p)}>
                    взять
                  </button>
                )}
              </>
            )}
          </td>
        )}
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
          {fromSupply && <span className="bid-source">цена снабжения</span>}
        </td>
        <td className="num bid-col-sum">{price != null && volume != null ? formatAmount(lineTotal(price, volume)) : 'нет цены'}</td>
        <td className="bid-col-note">
          <NoteInput value={r?.note || ''} disabled={!canEdit} label={`Примечание: ${p.name}`} onCommit={(note) => onCommit(p, { note })} />
        </td>
      </tr>
    )
  }

  if (!positions.length) {
    return <div className="bid-state">В ведомостях ВОР нет позиций этого вида.</div>
  }

  const cols = showSupply ? 8 : 7
  const big = list.length > VIRTUAL_FROM
  const missing = list.length - totals.priced
  return (
    <div className="bid-table-block">
      <div className="bid-filters">
        <input type="search" className="bid-search" placeholder={`Найти ${noun}…`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Поиск по наименованию" />
        {multi && (
          <select className="bid-select" value={vorId} onChange={(e) => onVorChange(e.target.value)} aria-label="Ведомость ВОР">
            <option value="">Все ВОР ({vors.length})</option>
            {vors.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
          </select>
        )}
        <label className="bid-check">
          <input type="checkbox" checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)} /> только без цены
        </label>
        {hasChanges && (
          <label className="bid-check">
            <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> только изменения ВОР
          </label>
        )}
        <span className={`bid-filters-total${missing > 0 ? ' is-incomplete' : ''}`}>
          с ценой {totals.priced} из {list.length}{missing > 0 ? ` · без цены ${missing}` : ''} · {formatAmount(totals.sum)} ₽
        </span>
      </div>
      <div className={`bid-table-wrap${big ? ' is-scroll' : ''}`} ref={scrollRef}>
        <table className={`bid-table${showSupply ? ' has-supply' : ''}`}>
          <colgroup>
            <col className="bid-w-n" /><col /><col className="bid-w-unit" /><col className="bid-w-vol" />
            {showSupply && <col className="bid-w-supply" />}
            <col className="bid-w-price" /><col className="bid-w-sum" /><col className="bid-w-note" />
          </colgroup>
          <thead>
            <tr>
              <th className="bid-col-n">№</th>
              <th>Наименование</th>
              <th>Ед. изм.</th>
              <th className="num">{vorId ? 'Объём в ВОР' : 'Объём'}</th>
              {showSupply && <th className="num" title="Цена снабжения СУ-10 с НДС и доставкой — отдел разрешил её взять">Цена СУ-10, ₽</th>}
              <th className="num">{vatExempt ? 'Цена за ед. без НДС, ₽' : 'Цена за ед. с НДС, ₽'}</th>
              <th className="num">{vatExempt ? 'Сумма без НДС, ₽' : 'Сумма с НДС, ₽'}</th>
              <th>Примечание</th>
            </tr>
          </thead>
          {big ? (
            <VirtualTableBody rowCount={list.length} renderRow={renderRow} colSpan={cols} scrollRef={scrollRef} rowHeight={44} />
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
