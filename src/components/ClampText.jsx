import { useId, useLayoutEffect, useRef, useState } from 'react'
import './ClampText.css'

// Длинный текст в ячейке: до `lines` строк, дальше — кнопка «Показать полностью»
// (мышью и с клавиатуры, aria-expanded). Кнопка появляется, только если текст
// действительно не помещается при текущей ширине колонки. Сам текст всегда
// полный — в DOM, в поиске и в выгрузке ничего не сокращается.
//
// wrap — если текст одновременно ссылка (переход в карточку): получает узел с
// текстом и оборачивает его. Кнопка раскрытия рендерится рядом, а не внутри
// ссылки: переход и раскрытие остаются двумя отдельными действиями.
export default function ClampText({ text, lines = 3, wrap, empty = '—', className = '' }) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef(null)
  const id = useId()

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const check = () => {
      if (!el.classList.contains('is-expanded')) setOverflows(el.scrollHeight > el.clientHeight + 1)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, lines])

  if (!text) return <span className="ui-empty">{empty}</span>

  const body = (
    <span
      ref={ref}
      id={id}
      className={`ui-clamp${expanded ? ' is-expanded' : ''}${className ? ` ${className}` : ''}`}
      style={{ '--ui-clamp-lines': lines }}
    >
      {text}
    </span>
  )
  return (
    <>
      {wrap ? wrap(body) : body}
      {(overflows || expanded) && (
        <button
          type="button"
          className="ui-clamp-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={(e) => { e.stopPropagation(); setExpanded(v => !v) }}
        >
          {expanded ? 'Свернуть' : 'Показать полностью'}
        </button>
      )}
    </>
  )
}
