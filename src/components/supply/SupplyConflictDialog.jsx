import { useEffect, useRef } from 'react'
import { formatAmount } from '../../utils/money'
import { rateUnitPrice } from '../../utils/supplyRateHelpers'

const fmtTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// Что ввели: цена или сумма, и доставка позиции, если она есть (миграция 20261120).
const describe = ({ mode, value, delivery }) => {
  const price = mode === 'total' ? `сумма${delivery ? ' без доставки' : ''} ${formatAmount(value)} ₽` : `цена ${formatAmount(value)} ₽ за ед.`
  return delivery ? `${price} + доставка ${formatAmount(delivery.value)} ₽ ${delivery.mode === 'total' ? 'на позицию' : 'за ед.'}` : price
}

// Цену позиции изменили, пока вы её вводили: значение не записано. Выбор — оставить их или записать своё.
// current — строка в базе сейчас (null — цену удалили).
export default function SupplyConflictDialog({ conflict, nameOf, onKeepTheirs, onWriteMine, onClose }) {
  const firstRef = useRef(null)
  useEffect(() => {
    firstRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (!conflict) return null
  const { position, mine, current } = conflict
  const who = current ? nameOf(current.updated_by) : null
  return (
    <div className="sp-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sp-modal" role="alertdialog" aria-modal="true" aria-labelledby="sp-conflict-title" aria-describedby="sp-conflict-text">
        <h3 id="sp-conflict-title">Цену уже изменили</h3>
        <div id="sp-conflict-text" className="sp-modal-body">
          <p className="sp-modal-item">{position.name}</p>
          {current ? (
            <p>
              {who || 'Другой пользователь'}{current.updated_at ? ` в ${fmtTime(current.updated_at)}` : ''} записал(а):{' '}
              <b className="ui-num">{formatAmount(rateUnitPrice(current))} ₽ за ед.</b>
              {current.supply_total != null && <> · сумма <b className="ui-num">{formatAmount(Number(current.supply_total))} ₽</b></>}
            </p>
          ) : (
            <p>Цену этой позиции удалил другой пользователь.</p>
          )}
          <p>Ваше значение: <b className="ui-num">{mine ? describe(mine) : 'очистить цену'}</b>. Оно не записано.</p>
        </div>
        <div className="sp-modal-actions">
          <button ref={firstRef} type="button" className="btn-secondary" onClick={onKeepTheirs}>
            {current ? 'Оставить их значение' : 'Оставить без цены'}
          </button>
          <button type="button" className="btn-primary" onClick={onWriteMine}>Записать моё</button>
        </div>
      </div>
    </div>
  )
}
