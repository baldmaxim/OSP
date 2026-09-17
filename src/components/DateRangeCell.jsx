import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatDateRange } from '../utils/dateRange'
import './DateRangeCell.css'

// Срок «с … по …» в строке таблицы: читаемым текстом вместо двух системных полей
// «дд.мм.гггг». Клик (для редакторов) открывает окошко с началом и окончанием.
//
// Окошко рисуется порталом с фиксированной позицией: таблица прокручивается
// внутри своего контейнера и обрезала бы его у нижних строк.
//
// onChange(field, value) — field: 'start' | 'end', value: 'YYYY-MM-DD' | ''.
// lockStart — начало задано извне (например, датой создания тендера): в окошке
// его не поменять, пока нет окончания — ячейка считается пустой.
// overdue — подсветить как просроченный (решает вызывающий код: он знает статус).
//
// Пока окошко открыто, даты живут в черновике и наружу не уходят: поле даты
// шлёт change на каждую цифру года («0002», «0020»…), сохранение и перерисовка
// с таким значением сбивали набор. Запись — по «Готово» или клику мимо окна,
// только полных дат; Esc — отмена.


// Полная дата с правдоподобным годом (не промежуточное «0002-09-21»).
function isCompleteDate(v) {
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(v || '')
  return !!m && +m[1] >= 1900 && +m[1] <= 2199
}

function parts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''))
  return m ? { y: m[1], m: m[2], d: m[3] } : null
}

export { formatDateRange }

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

export default function DateRangeCell({ start, end, onChange, disabled = false, overdue = false, showCountdown = true, lockStart = false, lockStartHint = '' }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const [draft, setDraft] = useState({ start: '', end: '' })
  const [error, setError] = useState('')
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

  // Актуальные значения для обработчиков документа (эффект подписан один раз на открытие).
  const latest = useRef({})
  latest.current = { draft, start, end, onChange, lockStart }

  const openPop = () => {
    setDraft({ start: start || '', end: end || '' })
    setError('')
    setOpen(true)
  }

  // Закрыть окошко; commit=true — записать изменившиеся полные (или очищенные) даты.
  const close = (commit) => {
    const { draft: d, start: s0, end: e0, onChange: cb } = latest.current
    if (commit && isCompleteDate(d.start) && isCompleteDate(d.end) && d.start > d.end) {
      setError(lockStart ? 'Окончание раньше даты начала' : 'Начало позже окончания')
      return
    }
    setOpen(false)
    if (!commit) return
    const apply = (field, next, prev) => {
      if ((next || '') === (prev || '')) return
      if (next && !isCompleteDate(next)) return
      cb(field, next)
    }
    if (!latest.current.lockStart) apply('start', d.start, s0)
    apply('end', d.end, e0)
  }
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
      closeRef.current(true)
    }
    const onKey = (e) => { if (e.key === 'Escape') closeRef.current(false) }
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

  const text = lockStart && !end ? '' : formatDateRange(start, end)
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
        onClick={() => { if (disabled) return; if (open) close(true); else openPop() }}
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
            <span>Начало{lockStart && lockStartHint ? ` · ${lockStartHint}` : ''}</span>
            <input
              type="date"
              value={draft.start}
              disabled={lockStart}
              title={lockStart ? (lockStartHint || 'Начало задаётся автоматически') : undefined}
              max={isCompleteDate(draft.end) ? draft.end : undefined}
              onChange={(e) => { const v = e.target.value; setError(''); setDraft(d => ({ ...d, start: v })) }}
            />
          </label>
          <label className="drc-field">
            <span>Окончание</span>
            <input
              type="date"
              value={draft.end}
              min={isCompleteDate(draft.start) ? draft.start : undefined}
              onChange={(e) => { const v = e.target.value; setError(''); setDraft(d => ({ ...d, end: v })) }}
            />
          </label>
          {error && <div className="drc-error" role="alert">{error}</div>}
          <div className="drc-actions">
            {(lockStart ? draft.end : (draft.start || draft.end)) && (
              <button
                type="button"
                className="drc-link"
                onClick={() => setDraft(d => ({ start: lockStart ? d.start : '', end: '' }))}
              >Очистить</button>
            )}
            <button type="button" className="drc-done" onClick={() => close(true)}>Готово</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}


