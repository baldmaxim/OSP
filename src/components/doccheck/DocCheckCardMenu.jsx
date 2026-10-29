import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconArchive, IconRestore, IconTrash } from '../icons/ActionIcons'
import { DOC_CHECK_COLORS } from '../../utils/docCheckHelpers'

// Меню карточки на доске («⋮»): цвет, перенос в колонку, архив, удаление.
// Рисуется в <body> с fixed-позицией у кнопки: колонка доски прокручивается и
// обрезала бы меню у нижней карточки. Закрывается щелчком мимо, Escape и прокруткой.
export default function DocCheckCardMenu({ request, anchor, statuses, hasBoardFields, onAction, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ top: anchor.bottom + 4, left: anchor.right })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))
    const below = anchor.bottom + 4
    const top = below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 4) : below
    setPos({ top, left })
  }, [anchor])

  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    // Прокрутка, которую вызвал сам щелчок по «⋮» (кнопка у края — браузер докручивает к ней), меню не закрывает.
    const openedAt = performance.now()
    const onScroll = (e) => { if (performance.now() - openedAt > 250 && !ref.current?.contains(e.target)) onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const act = (type, value) => { onClose(); onAction(request, type, value) }

  return createPortal(
    <div ref={ref} className="dc-menu" role="menu" style={{ top: pos.top, left: pos.left }}>
      <button type="button" role="menuitem" className="dc-menu-item" onClick={() => act('open')}>Открыть заявку</button>

      {hasBoardFields && (
        <div className="dc-menu-group">
          <div className="dc-menu-caption">Цвет карточки</div>
          <div className="dc-menu-colors">
            <button
              type="button"
              className={`dc-swatch dc-swatch--none${!request.color ? ' is-current' : ''}`}
              aria-label="Без цвета"
              title="Без цвета"
              onClick={() => act('color', null)}
            />
            {DOC_CHECK_COLORS.map(c => (
              <button
                key={c.value}
                type="button"
                className={`dc-swatch dc-c-${c.value}${request.color === c.value ? ' is-current' : ''}`}
                aria-label={c.label}
                title={c.label}
                onClick={() => act('color', c.value)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="dc-menu-group">
        <div className="dc-menu-caption">Переместить в колонку</div>
        {statuses.map(s => (
          <button
            key={s.value}
            type="button"
            role="menuitem"
            className={`dc-menu-item dc-menu-status ${s.className}${request.status === s.value ? ' is-current' : ''}`}
            disabled={request.status === s.value}
            onClick={() => act('status', s.value)}
          >{s.label}</button>
        ))}
      </div>

      <div className="dc-menu-group">
        {hasBoardFields && (request.archived_at ? (
          <button type="button" role="menuitem" className="dc-menu-item" onClick={() => act('unarchive')}>
            <IconRestore size={14} />Вернуть из архива
          </button>
        ) : (
          <button type="button" role="menuitem" className="dc-menu-item" onClick={() => act('archive')}>
            <IconArchive size={14} />В архив
          </button>
        ))}
        <button type="button" role="menuitem" className="dc-menu-item is-danger" onClick={() => act('delete')}>
          <IconTrash size={14} />Удалить
        </button>
      </div>
    </div>,
    document.body,
  )
}
