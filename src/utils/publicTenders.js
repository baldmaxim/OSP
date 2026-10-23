// Публичная страница тендеров (/public/tenders) без обращения к базе: вид дат, проверка ссылок,
// письмо в общий ящик, строка поиска. Их проверяет и тест без браузера —
// tests/tender/public-tenders.test.mjs. Данные — представление public_open_tenders (миграции
// 20261016, 20261101): гость читает только его. Телефон — как у контакта площадки (phoneHref).
import { TENDER_MAILBOX, phoneHref } from './siteContacts.js'

export { TENDER_MAILBOX, phoneHref }

const MONTHS_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

// task 195: «15 июня» — без года. Дата из базы — «ГГГГ-ММ-ДД» (тип date): разбираем строку сами —
// new Date('2026-06-15') это полночь UTC, и западнее Гринвича вышло бы «14 июня».
export function formatShortDate(d) {
  if (!d) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d))
  if (!m) return String(d)
  const month = MONTHS_RU[Number(m[2]) - 1]
  return month ? `${Number(m[3])} ${month}` : String(d)
}

export function formatShortRange(start, end) {
  if (!start && !end) return '—'
  if (start && end) return `${formatShortDate(start)} — ${formatShortDate(end)}`
  return formatShortDate(start || end)
}

// Ссылки вносят сотрудники, а страница открыта всем: ссылкой становится только адрес http(s).
// javascript:, data: и сетевые пути (\\сервер\папка — гостю всё равно не открыть) — не ссылка.
export function safeHttpUrl(value) {
  const v = String(value ?? '').trim()
  if (!v || v.length > 2000 || !/^https?:\/\/\S+$/i.test(v)) return null
  try {
    const url = new URL(v)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

// Письмо в общий ящик отдела: тема — объект и номер тендера, как в письме-приглашении подрядчикам
// («Объект … / Тендер № …»; там же просьба указать, по какому тендеру и объекту обращаетесь).
export function mailSubject(tender) {
  const num = tender?.public_tender_number
  return [
    tender?.object_name ? `Объект ${tender.object_name}` : null,
    num != null ? `Тендер № ${num}` : 'Вопрос по тендеру',
  ].filter(Boolean).join(' / ')
}

export const mailHref = (tender) => `mailto:${TENDER_MAILBOX}?subject=${encodeURIComponent(mailSubject(tender))}`

// Поиск без учёта регистра и «ё»: строка поиска складывается один раз при загрузке, а не на каждую букву.
export const normalizeSearch = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()

export function searchText(tender) {
  return normalizeSearch([
    tender.public_tender_number != null ? String(tender.public_tender_number) : '',
    tender.object_name,
    tender.object_address,
    tender.work_description,
    tender.responsible_name,
  ].filter(Boolean).join(' '))
}
