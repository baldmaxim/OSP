import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './DateRangeCell.css'

// Срок «с … по …» в строке таблицы: читаемым текстом вместо двух системных полей
// «дд.мм.гггг». Клик (для редакторов) открывает окошко с началом и окончанием.
//
// Окошко рисуется порталом с фиксированной позицией: таблица прокручивается
// внутри своего контейнера и обрезала бы его у нижних строк.
//
// onChange(field, value) — field: 'start' | 'end', value: 'YYYY-MM-DD' | ''.
// overdue — подсветить как просроченный (решает вызывающий код: он знает статус).


function parts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''))
  return m ? { y: m[1], m: m[2], d: m[3] } : null
}

// «10.09 — 23.09.2026»; год у начала — только если годы разные.
export function formatDateRange(start, end) {
  const s = parts(start)
  const e = parts(end)
  if (s && e) {
    const left = s.y === e.y ? `${s.d}.${s.m}` : `${s.d}.${s.m}.${s.y}`
    return `${left} — ${e.d}.${e.m}.${e.y}`
  }
  if (s) return `с ${s.d}.${s.m}.${s.y}`
  if (e) return `до ${e.d}.${e.m}.${e.y}`
  return ''
}

// Сколько дней до окончания (отрицательное — просрочено), по календарным дням.
function daysUntil(iso) {
  const p = parts(iso)
  if (!p) return null
  const now = new Date()
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const end = Date.UTC(+p.y, +p.m - 1, +p.d)
  return Math.round((end - today) / 86400000)
}

const IconCalendar = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
)

export default function DateRangeCell({ start, end, onChange, disabled = false, overdue = false, showCountdown = true }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const popRef = useRef(null)

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const width = 260
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8)
    const below = window.innerHeight - r.bottom
    // Не помещается снизу — раскрываем вверх.
    setPos(below < 190
      ? { left, bottom: window.innerHeight - r.top + 6, width }
      : { left, top: r.bottom + 6, width })
  }

  useLayoutEffect(() => { if (open) place() }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    const onMove = () => place()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  const text = formatDateRange(start, end)
  const left = end ? daysUntil(end) : null
  const hint = !showCountdown || left == null ? null
    : overdue ? `просрочено на ${Math.abs(left)} дн.`
      : left === 0 ? 'сегодня'
        : left > 0 && left <= 3 ? `осталось ${left} дн.`
          : null

  const cls = [
    'drc-btn',
    !text ? 'is-empty' : '',
    overdue ? 'is-overdue' : '',
    !overdue && left != null && left >= 0 && left <= 3 ? 'is-soon' : '',
    disabled ? 'is-readonly' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className="drc">
      <button
        ref={btnRef}
        type="button"
        className={cls}
        onClick={() => { if (!disabled) setOpen(o => !o) }}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={disabled ? undefined : 'Изменить срок'}
        disabled={disabled && !text}
      >
        <IconCalendar />
        <span className="drc-text">{text || (disabled ? '—' : 'Указать срок')}</span>
      </button>
      {hint && <div className={`drc-hint${overdue ? ' is-overdue' : ''}`}>{hint}</div>}

      {open && pos && createPortal(
        <div
          ref={popRef}
          className="drc-pop"
          role="dialog"
          aria-label="Срок"
          style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width }}
        >
          <label className="drc-field">
            <span>Начало</span>
            <input
              type="date"
              value={start || ''}
              max={end || undefined}
              onChange={(e) => onChange('start', e.target.value)}
            />
          </label>
          <label className="drc-field">
            <span>Окончание</span>
            <input
              type="date"
              value={end || ''}
              min={start || undefined}
              onChange={(e) => onChange('end', e.target.value)}
            />
          </label>
          <div className="drc-actions">
            {(start || end) && (
              <button
                type="button"
                className="drc-link"
                onClick={() => { if (start) onChange('start', ''); if (end) onChange('end', ''); setOpen(false) }}
              >Очистить</button>
            )}
            <button type="button" className="drc-done" onClick={() => setOpen(false)}>Готово</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}


