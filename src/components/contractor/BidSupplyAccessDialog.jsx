import { useEffect, useId } from 'react'
import { createPortal } from 'react-dom'
import BidSupplyAccessBlock from './BidSupplyAccessBlock'
import './BidRequestsBlock.css'

// Окно «Цены снабжения подрядчикам» из строки «Тендеров на материалы» (решение пользователя 25.11.2026, миграция 20270303): строки
// реестра материалов не раскрываются, поэтому список подрядчиков основного тендера — в окне. Только инженеру ОСП и администратору
// (кнопку другим страница не показывает). Окно — в <body>: строка таблицы его обрезала бы.
export default function BidSupplyAccessDialog({ tenderId, tenderNumber, title, onDecided, onClose }) {
  const titleId = useId()
  useEffect(() => {
    // Окно позиций поверх этого закрывается своим Escape (оно ловит клавишу раньше и дальше не пускает).
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="bsi-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bsi-dialog bsa-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="bsi-head">
          <div>
            <h3 id={titleId}>Цены снабжения подрядчикам{tenderNumber != null ? ` · тендер № ${tenderNumber}` : ''}</h3>
            {title && <p className="bsi-sub">{title}</p>}
          </div>
          <button type="button" className="bsi-close" aria-label="Закрыть" onClick={onClose}>×</button>
        </div>
        <div className="bsi-body bsa-body">
          <p className="bsi-lead">
            Подрядчик просит цены снабжения в своём кабинете. Открывайте их по позициям («Выбрать позиции…») или всеми сразу; цены
            видны подрядчику только по открытым позициям, пока идёт приём предложений.
          </p>
          <BidSupplyAccessBlock tenderId={tenderId} tenderNumber={tenderNumber} onDecided={onDecided} emptyText="На сайте у этого тендера пока нет подрядчиков с учёткой кабинета." />
        </div>
        <div className="bsi-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
