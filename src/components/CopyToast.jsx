import { useEffect, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { copyToClipboard } from '../utils/clipboard'
import './CopyToast.css'

// Копирование по нажатию с плашкой внизу экрана: «Номер скопирован», «Email скопирован» с зелёной галочкой
// (30.10.2026, по просьбе пользователя — телефоны и почта контактов участников тендера).
//
// copyWithToast(text, message) копирует и на пару секунд показывает плашку; повторное нажатие показывает её
// заново. Не скопировалось (браузер не дал) — плашка «Не удалось скопировать». Плашка рисуется в своём корне
// в <body>, как подсказка FolderOpen: зовут из ячеек таблиц, провайдер на страницу не нужен.

const TOAST_MS = 1800

let state = { toast: null }
const listeners = new Set()
const setState = (patch) => {
  state = { ...state, ...patch }
  listeners.forEach(l => l())
}
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l) }
const getState = () => state

function ensureHost() {
  if (document.getElementById('osp-copy-toast')) return
  const el = document.createElement('div')
  el.id = 'osp-copy-toast'
  document.body.appendChild(el)
  createRoot(el).render(<CopyToastHost />)
}

export async function copyWithToast(text, message = 'Скопировано') {
  const value = String(text ?? '').trim()
  if (!value) return false
  const ok = await copyToClipboard(value)
  ensureHost()
  setState({ toast: { ok, text: ok ? message : 'Не удалось скопировать', id: Date.now() } })
  return ok
}

const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

const closeToast = () => setState({ toast: null })

function CopyToastHost() {
  const { toast } = useSyncExternalStore(subscribe, getState)
  useEffect(() => {
    if (!toast) return undefined
    const t = setTimeout(closeToast, TOAST_MS)
    return () => clearTimeout(t)
  }, [toast])
  // Область role="status" стоит всегда — экранный диктор читает плашку, появившуюся внутри неё.
  // key — каждое нажатие заново проигрывает появление.
  return (
    <div role="status">
      {toast && (
        <div key={toast.id} className={`copy-toast${toast.ok ? '' : ' is-error'}`}>
          {toast.ok && <span className="copy-toast-ic"><IconCheck /></span>}
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  )
}
