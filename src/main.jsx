import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { uuidv4Manual } from './utils/uuid'

// Полифил crypto.randomUUID — на http:// и в старых браузерах метод отсутствует,
// и любая сторонняя зависимость, дёргающая его напрямую, падает с TypeError.
// Важно: используем uuidv4Manual (а НЕ generateUUID), чтобы не получить
// бесконечную рекурсию — generateUUID проверяет crypto.randomUUID и вызывал бы себя.
if (typeof globalThis !== 'undefined') {
  if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = {}
  }
  if (typeof globalThis.crypto.randomUUID !== 'function') {
    globalThis.crypto.randomUUID = uuidv4Manual
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
