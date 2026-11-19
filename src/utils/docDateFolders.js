// Папки по дню загрузки в списке файлов (S3DocumentList с пропом dateFolders; «Должная осмотрительность» карточки
// контрагента, решение пользователя 19.11.2026: файлы проверки обычно грузят одним днём). Папка — календарный день
// created_at по часам браузера, тот же, что в колонке «Когда»: строка «19.11.2026 00:30» не попадает в папку 18.11.
// Отдельного поля в базе нет: каждый файл, и прежний, и новый, лежит в папке дня своей загрузки.

const pad = (n) => String(n).padStart(2, '0')

// ISO-время → 'YYYY-MM-DD' по местным часам; нет или не разобрать — ''.
export function localDayKey(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 'YYYY-MM-DD' → 'ДД.ММ.ГГГГ'; '' → «Без даты».
export function dayLabel(key) {
  if (!key) return 'Без даты'
  const [y, m, d] = key.split('-')
  return `${d}.${m}.${y}`
}

// Время загрузки внутри папки — день уже в её заголовке.
export function localTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Документы → папки [{ key, label, docs }]: новые дни сверху, «Без даты» — в конце; внутри папки порядок как во входе
// (список приходит от новых к старым).
export function groupDocsByDay(docs) {
  const byKey = new Map()
  for (const doc of docs || []) {
    const key = localDayKey(doc.created_at)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(doc)
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => {
      if (!a) return 1
      if (!b) return -1
      return a < b ? 1 : a > b ? -1 : 0
    })
    .map(([key, list]) => ({ key, label: dayLabel(key), docs: list }))
}

// «1 файл», «3 файла», «12 файлов».
export function filesCountLabel(n) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} файл`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} файла`
  return `${n} файлов`
}
