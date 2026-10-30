// Реестр расценок → «Расценки от подрядчиков (КП)» (миграция 20261122): откуда строка реестра и документ строки,
// поля расценки, добавленной вручную. Только решения, без запросов — tests/tender/kp-rate-check.test.mjs.
import { parseAmount, roundMoney } from './money.js'

// source_kind строки реестра: КП из файла (ВОР позиции и файл КП, сохранённый вместе с ценами), цена с сайта
// (кабинет подрядчика, завершённый тендер) или добавлена вручную.
export const SOURCE_KINDS = {
  kp: 'КП из файла',
  site: 'Кабинет подрядчика',
  manual: 'Добавлено вручную',
}
export const SOURCE_FILTER_OPTIONS = [
  { value: '', label: 'Все источники' },
  ...Object.entries(SOURCE_KINDS).map(([value, label]) => ({ value, label })),
]

// Документ ручной расценки — адрес http(s) или сетевой путь \\сервер\папка (как проверяет база). Пусто — без адреса.
// Ответ: { url } (url может быть null) | { error }.
export function normalizeDocUrl(raw) {
  const url = String(raw ?? '').trim()
  if (!url) return { url: null }
  if (url.length > 2000) return { error: 'Ссылка длиннее 2000 знаков' }
  if (/^https?:\/\/\S/i.test(url) || /^\\\\\S/.test(url)) return { url }
  return { error: 'Нужна ссылка вида https://… или сетевой путь \\\\сервер\\папка' }
}
export const isWebLink = (url) => /^https?:\/\//i.test(String(url || ''))

// Сегодня по Москве — «ГГГГ-ММ-ДД» (день расценки по умолчанию, как в базе).
const MSK_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' })
export const moscowToday = (now = new Date()) => MSK_DAY.format(now)

export const MANUAL_NAME_MAX = 1000
export const MANUAL_NOTE_MAX = 2000

// Поля формы → строка для базы { item_type, item_name, unit, price, counterparty_id, object_id, tender_id, rate_date,
// doc_url, note } | { error }. Цена — за единицу с НДС, как у КП в реестре.
export function validateManualRate(form) {
  const name = String(form.item_name ?? '').replace(/\s+/g, ' ').trim()
  if (!name) return { error: 'Укажите наименование' }
  if (name.length > MANUAL_NAME_MAX) return { error: `Наименование длиннее ${MANUAL_NAME_MAX} знаков` }
  if (form.item_type !== 'material' && form.item_type !== 'work') return { error: 'Выберите: материал или работа' }
  const price = roundMoney(parseAmount(form.price))
  if (price == null || !(price > 0)) return { error: 'Укажите цену за единицу больше нуля' }
  if (price >= 1e12) return { error: 'Слишком большая цена' }
  if (!form.counterparty_id) return { error: 'Выберите подрядчика' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(form.rate_date || ''))) return { error: 'Укажите дату расценки' }
  const unit = String(form.unit ?? '').trim()
  if (unit.length > 50) return { error: 'Ед. изм. — не длиннее 50 знаков' }
  const note = String(form.note ?? '').trim()
  if (note.length > MANUAL_NOTE_MAX) return { error: `Примечание длиннее ${MANUAL_NOTE_MAX} знаков` }
  const link = normalizeDocUrl(form.doc_url)
  if (link.error) return { error: link.error }
  return {
    rate: {
      item_type: form.item_type,
      item_name: name,
      unit: unit || null,
      price,
      counterparty_id: form.counterparty_id,
      object_id: form.object_id || null,
      tender_id: form.tender_id || null,
      rate_date: form.rate_date,
      doc_url: link.url,
      note: note || null,
    },
  }
}

// Подпись тендера в выборе: «№ 412 · Полы паркинга».
export const tenderLabel = (t) => `${t.public_tender_number ? `№ ${t.public_tender_number} · ` : ''}${t.work_description || 'без описания'}`
