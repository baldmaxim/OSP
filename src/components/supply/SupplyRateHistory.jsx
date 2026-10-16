import { useEffect, useRef, useState } from 'react'
import { formatAmount } from '../../utils/money'
import { loadRateHistory } from '../../services/supplyPricing'

const fmtTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
const money = (v) => (v == null ? '—' : `${formatAmount(Number(v))} ₽`)
const SOURCE = { unit: 'цена за ед.', total: 'итоговая сумма', import: 'Excel в карточке' }

// Что было с ценой позиции: журнал tender_supply_rate_log (пишет база на каждое изменение, откуда бы оно ни шло).
// «Вернуть» — записать прежнее значение тем же способом, каким его вводили.
export default function SupplyRateHistory({ mainId, target, canRestore, onRestore, onClose }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const closeRef = useRef(null)
  useEffect(() => {
    let alive = true
    loadRateHistory(mainId, target.rate
      ? { rateId: target.rate.id }
      : { estimateName: target.estimateName, materialName: target.position.name })
      .then((data) => { if (alive) setRows(data) })
      .catch((e) => { if (alive) setError(e.message || 'Не удалось загрузить историю') })
    closeRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { alive = false; window.removeEventListener('keydown', onKey) }
  }, [mainId, target, onClose])

  // Значение, к которому можно вернуться: после изменения (или до удаления).
  const valueOf = (r) => (r.op === 'delete'
    ? { price: r.old_price, total: r.old_total, input: r.old_input }
    : { price: r.new_price, total: r.new_total, input: r.new_input })

  return (
    <div className="sp-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sp-modal sp-modal-wide" role="dialog" aria-modal="true" aria-labelledby="sp-history-title">
        <h3 id="sp-history-title">История цены</h3>
        <p className="sp-modal-item">{target.position.name}</p>
        <div className="sp-modal-body">
          {error && <p className="sp-error-text">{error}</p>}
          {!error && rows === null && <p className="sp-muted">Загрузка…</p>}
          {rows?.length === 0 && <p className="sp-muted">Изменений нет.</p>}
          {rows?.length > 0 && (
            <ol className="sp-history">
              {rows.map((r) => {
                const v = valueOf(r)
                // Перенос между ВОР цену не менял — возвращать нечего.
                const restorable = canRestore && !(r.op === 'update' && r.old_estimate_name)
                return (
                  <li key={r.id}>
                    <div className="sp-history-head">
                      <span className="ui-num">{fmtTime(r.changed_at)}</span>
                      <span>{r.changed_by_name || 'Пользователь'}</span>
                    </div>
                    <div className="sp-history-what">
                      {r.op === 'delete' && <>Цена удалена (была {money(r.old_price)} за ед.)</>}
                      {r.op === 'insert' && <>Цена {money(r.new_price)} за ед.{r.new_total != null && <>, сумма {money(r.new_total)}</>} · {SOURCE[r.new_input] || 'ввод'}</>}
                      {r.op === 'update' && r.old_estimate_name && <>Перенесена из ВОР «{r.old_estimate_name}» в «{r.estimate_name}»</>}
                      {r.op === 'update' && !r.old_estimate_name && (
                        <>{money(r.old_price)} → {money(r.new_price)} за ед.{r.new_total != null && <>, сумма {money(r.new_total)}</>} · {SOURCE[r.new_input] || 'ввод'}</>
                      )}
                    </div>
                    {restorable && v.price != null && (
                      <button type="button" className="sp-link-btn" onClick={() => onRestore(v)}>
                        Вернуть {v.input === 'total' && v.total != null ? `сумму ${money(v.total)}` : `цену ${money(v.price)}`}
                      </button>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </div>
        <div className="sp-modal-actions">
          <button ref={closeRef} type="button" className="btn-secondary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}
