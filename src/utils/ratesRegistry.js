// Общее для вкладок «Реестра расценок» (src/pages/RatesRegistryPage.jsx, src/pages/LarixRegistrySection.jsx):
// форматирование, понятные ошибки, фильтры, выгрузка в Excel.
import { useState, useEffect } from 'react'
import * as XLSX from 'xlsx'

// Один форматтер на модуль: конструктор Intl.NumberFormat дорогой, а вызывается на каждую ячейку.
const MONEY_FMT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })
export const fmtMoney = (n) => {
  if (n == null || n === '' || isNaN(n)) return ''
  return MONEY_FMT.format(n)
}

// Дата без времени (колонка date: «2025-01-20») показывается как есть, без сдвига часового пояса:
// new Date('2025-01-20') — полночь UTC, и западнее Гринвича это был бы предыдущий день.
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
export const fmtDate = (iso) => {
  if (!iso) return '—'
  const day = DAY_RE.exec(String(iso))
  if (day) return `${day[3]}.${day[2]}.${day[1]}`
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('ru-RU')
}

// Отметка свежести данных. Сегодняшнее время показываем без даты — так короче
// и сразу понятно, насколько давно был пересчёт.
export const fmtRefreshed = (iso) => {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const isToday = d.toDateString() === new Date().toDateString()
  return isToday ? time : `${d.toLocaleDateString('ru-RU')} ${time}`
}

// Понятное сообщение вместо «сырой» ошибки базы. Реестр опирается на таблицы и представления,
// которых нет, пока не применена миграция: Postgres отвечает 42P01, PostgREST — PGRST205 (нет
// таблицы) или PGRST202 (нет функции). На больших выборках точный count может упереться в
// statement_timeout (57014).
const REGISTRY_MISSING = 'Реестр расценок ещё не настроен в базе данных: не найдено нужное представление. Обратитесь к администратору — требуется применить миграции реестра (kp_rates_registry / supply_rates_registry).'
export const isMissingRelation = (err) => {
  const code = err?.code
  const msg = String(err?.message || '')
  return code === '42P01' || code === 'PGRST205' || code === 'PGRST202'
    || /does not exist|не существует|relation .* does not exist|could not find the table/i.test(msg)
}
export const describeRegistryError = (err, missingText = REGISTRY_MISSING) => {
  const code = err?.code
  const msg = String(err?.message || '')
  if (isMissingRelation(err)) return missingText
  if (code === '57014' || /statement timeout|canceling statement/i.test(msg)) {
    return 'Запрос к реестру не успел выполниться из-за большого объёма данных. Уточните фильтры (объект, тендер или наименование), чтобы сузить выборку, либо повторите попытку.'
  }
  return msg || 'Не удалось загрузить реестр'
}

export const PAGE_SIZES = [50, 100, 250]

// Debounce значения (для поиска).
export function useDebounced(value, delay) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

// Фильтр множественного выбора → .in(). Пустой выбор = фильтр не применён.
// Если выбрано ВСЁ, предикат тоже не добавляем: результат тот же, но длинный список id
// раздул бы URL запроса до отказа (эта грабля уже ловилась в задаче 402).
export function applyInFilter(q, column, values, totalOptions) {
  if (!values || values.length === 0) return q
  if (totalOptions > 0 && values.length >= totalOptions) return q
  return q.in(column, values)
}

// Экспорт в Excel учитывает текущие фильтры. Данные грузятся ПОСТРАНИЧНО: Supabase
// по умолчанию отдаёт максимум 1000 строк, а выгрузка всей базы — это тысячи строк
// (та же грабля, что в счётчиках КП). makeQuery(from, to) должен вернуть готовый
// query-builder с .range(from, to).
export async function fetchAllRows(makeQuery) {
  const PAGE = 1000
  const all = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery(from, from + PAGE - 1)
    if (error) throw error
    if (data?.length) all.push(...data)
    if (!data || data.length < PAGE) break
  }
  return all
}

export function downloadXlsx(headers, dataRows, sheetName, fileName, colWidths) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows])
  if (colWidths) ws['!cols'] = colWidths.map(w => ({ wch: w }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  XLSX.writeFile(wb, fileName)
}

export function todayStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
