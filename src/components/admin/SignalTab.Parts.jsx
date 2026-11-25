import { useEffect, useId, useRef } from 'react'

// Общие части вкладки «Администрирование» → «Signal» (SignalTab.jsx, SignalTab.Folders.jsx): подпись-чип, окно, копирование.
// Стили — SignalTab.css (префикс sg-).

export function Chip({ tone = '', children, title }) {
  return <span className={`sg-chip${tone ? ` is-${tone}` : ''}`} title={title}>{children}</span>
}

// Окно: поверх страницы, Escape закрывает (пока не идёт запрос), фокус — на первое поле.
export function Modal({ title, onClose, busy = false, children, wide = false }) {
  const titleId = useId()
  const ref = useRef(null)
  useEffect(() => {
    const first = ref.current?.querySelector('input:not([type=checkbox]), select, textarea')
    ;(first || ref.current)?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [busy, onClose])
  return (
    <div className="sg-overlay">
      <div className={`sg-dialog${wide ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div className="sg-dialog-head">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="sg-close" onClick={onClose} disabled={busy} aria-label="Закрыть">×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// В буфер обмена: сначала Clipboard API, затем запасной путь (скрытое поле + execCommand) — на страницах без права на буфер.
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* нет права на буфер — пробуем запасной путь */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}
