// Ручная реализация UUID v4. НЕ обращается к crypto.randomUUID — поэтому безопасно
// использовать как полифил для самого crypto.randomUUID (см. main.jsx).
export function uuidv4Manual() {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  // Версия (v4) и вариант (RFC 4122)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = []
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}

// Универсальная генерация UUID v4: предпочитаем нативный crypto.randomUUID,
// fallback — на ручную реализацию.
// crypto.randomUUID() недоступен в незащищённых контекстах (http://) и в старых браузерах.
export function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return uuidv4Manual()
}

// UUID v7 (RFC 9562): первые 48 бит — время в мс, остальное случайное. Ключ операции загрузки файла
// (src/api/ospFiles.js): создаётся в браузере, растёт со временем.
export function uuidv7(now = Date.now()) {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  const t = Math.floor(now)
  // Деление, а не сдвиг: время больше 32 бит; от каждого частного нужен младший байт.
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(t / 2 ** (8 * (5 - i))) & 0xff
  bytes[6] = (bytes[6] & 0x0f) | 0x70 // версия 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // вариант RFC
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
