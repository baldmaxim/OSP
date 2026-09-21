import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './ContractPreviewCard.css'

// Мини-карточка договора — popover поверх таблицы, привязанный к строке.
// Открывается по клику на «Договор / № ДС». Механика позиционирования и закрытия
// (portal → body, fixed-координаты из getBoundingClientRect, click-outside + Escape +
// reflow на scroll/resize) — по образцу src/components/FilterDropdown.jsx.

const PANEL_W = 340

function formatDateRu(iso) {
  if (!iso) return null
  const [y, m, d] = String(iso).slice(0, 10).split('-')
  if (!y || !m || !d) return null
  return `${d}.${m}.${y}`
}

export default function ContractPreviewCard({
  contract,
  anchorEl,
  counterpartyName,
  objectName,
  workName,
  amountText,
  lawyerName,
  statusLabel,
  statusClassName,
  isOverdue,
  onClose,
  onOpenCard,
  onEdit,
}) {
  const panelRef = useRef(null)
  const [coords, setCoords] = useState(null)

  const computeCoords = () => {
    if (!anchorEl) return null
    const r = anchorEl.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = Math.min(PANEL_W, vw - 24)
    // По горизонтали — от левого края ссылки, но не заезжаем за правый край.
    let left = r.left
    if (left + width > vw - 12) left = vw - 12 - width
    if (left < 12) left = 12
    // По вертикали — под ссылкой, но при нехватке места разворачиваемся вверх.
    const spaceBelow = vh - r.bottom
    const spaceAbove = r.top
    const c = { width }
    const maxHeight = Math.max(200, Math.min(460, (spaceBelow < 300 && spaceAbove > spaceBelow ? spaceAbove : spaceBelow) - 16))
    c.maxHeight = maxHeight
    if (spaceBelow < 300 && spaceAbove > spaceBelow) {
      c.bottom = vh - r.top + 6
    } else {
      c.top = r.bottom + 6
    }
    c.left = left
    return c
  }

  useLayoutEffect(() => {
    setCoords(computeCoords())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorEl, contract?.id])

  useEffect(() => {
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target)) return
      // Клик по самой ссылке-триггеру закрытие делает родитель (тоггл) — не мешаем.
      if (anchorEl?.contains(e.target)) return
      onClose()
    }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    const onReflow = () => setCoords(computeCoords())
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onReflow, true)
    window.addEventListener('resize', onReflow)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onReflow, true)
      window.removeEventListener('resize', onReflow)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorEl, onClose])

  if (!coords) return null

  const numberText = contract.contract_number ? `№ ${contract.contract_number}` : '—'
  const dateText = formatDateRu(contract.contract_date)
  const accepted = formatDateRu(contract.accepted_date) || '—'
  const planned = formatDateRu(contract.signed_date)
  const note = (contract.notes || '').trim()

  const style = {
    position: 'fixed',
    left: coords.left,
    width: coords.width,
    maxHeight: coords.maxHeight,
  }
  if (coords.top != null) style.top = coords.top
  if (coords.bottom != null) style.bottom = coords.bottom

  return createPortal(
    <div
      ref={panelRef}
      className="contract-preview-card"
      style={style}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="cpc-header">
        <span className="cpc-title">Договор / ДС</span>
        <button className="cpc-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">×</button>
      </div>

      <div className="cpc-body">
        <div className="cpc-field">
          <span className="cpc-label">№ договора / ДС</span>
          <span className="cpc-value">{numberText}{dateText ? ` · от ${dateText}` : ''}</span>
        </div>
        <div className="cpc-field">
          <span className="cpc-label">Контрагент</span>
          <span className="cpc-value">{counterpartyName || '—'}</span>
        </div>
        <div className="cpc-field">
          <span className="cpc-label">Объект</span>
          <span className="cpc-value">{objectName || '—'}</span>
        </div>
        <div className="cpc-field">
          <span className="cpc-label">Выполняемые работы</span>
          <span className="cpc-value">{workName || '—'}</span>
        </div>
        <div className="cpc-field">
          <span className="cpc-label">Сумма</span>
          <span className="cpc-value">{amountText || '—'}</span>
        </div>
        <div className="cpc-field">
          <span className="cpc-label">Статус</span>
          <span className="cpc-value">
            <span className={`status-badge-inline ${statusClassName || ''}`}>{statusLabel || '—'}</span>
          </span>
        </div>
        <div className="cpc-field">
          <span className="cpc-label">Ответственный юрист</span>
          <span className="cpc-value">{lawyerName || '—'}</span>
        </div>
        <div className="cpc-field">
          <span className="cpc-label">Дата принятия в работу</span>
          <span className="cpc-value">{accepted}</span>
        </div>
        <div className="cpc-field">
          <span className="cpc-label">Планируемая дата подписания</span>
          <span className={`cpc-value ${isOverdue ? 'cpc-overdue' : ''}`}>
            {planned || '—'}{isOverdue && ' ⚠'}
          </span>
        </div>
      </div>

      <div className="cpc-note-block">
        <div className="cpc-note-title">Примечание</div>
        {note
          ? <div className="cpc-note-text">{note}</div>
          : <div className="cpc-note-empty">Примечание не заполнено</div>}
      </div>

      <div className="cpc-actions">
        <button className="btn-secondary cpc-btn" onClick={onOpenCard}>Открыть карточку</button>
        <button className="btn-primary cpc-btn" onClick={onEdit}>Редактировать</button>
      </div>
    </div>,
    document.body,
  )
}
