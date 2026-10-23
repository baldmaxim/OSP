// Анкета подрядчика в кабинете (bid_form_fields / tender_bid_forms, миграция 20261102) — правила без базы.
//
// Поле — текст или выбор из списка (kind = 'select', options). Поле с кодом 'vat' — ставка НДС подрядчика: в файле
// ВОР её выбирают из выпадающего списка на «Главном листе» («Указать % НДС из выпадающего списка»), в кабинете — так
// же; по ней в итогах расценки показывается «в т. ч. НДС», и она — ставка по умолчанию в «Ценах из файла».
// Ставки — те же, что у контрагентов (utils/counterpartyVat.js): 22, 7, 5, 0 %. «Без НДС», 20 и 10 % из выбора убраны
// (23.10.2026), но прежний ответ «Без НДС» по-прежнему понимается: цены без НДС.
import { VAT_RATES } from './counterpartyVat.js'

export const VAT_FIELD_CODE = 'vat'
export const VAT_EXEMPT_TEXT = 'Без НДС'
export const VAT_OPTIONS = VAT_RATES.map((r) => `${r} %`)
export const FIELD_KINDS = { text: 'Текст', select: 'Выбор из списка' }

// Ответ поля НДС → { rate, exempt } | null (не указан). «22 %», «22», «22%», «Без НДС», «без ндс».
export function parseVatAnswer(value) {
  const v = String(value ?? '').trim()
  if (!v) return null
  if (/^без\s*ндс$/i.test(v)) return { rate: 0, exempt: true }
  const m = /^(\d{1,2}(?:[.,]\d{1,2})?)\s*%?$/.exec(v)
  if (!m) return null
  const rate = Number(m[1].replace(',', '.'))
  return rate >= 0 && rate < 100 ? { rate, exempt: false } : null
}

// Сколько НДС внутри суммы с НДС: сумма × ставка / (100 + ставка), до копеек. Без НДС или ставка 0 — 0.
export function vatIncluded(total, vat) {
  if (!vat || vat.exempt || !vat.rate || total == null) return 0
  return Math.round((total * vat.rate) / (100 + vat.rate) * 100) / 100
}

// «22 %» / «Без НДС» / «не указан».
export const vatLabel = (vat) => (!vat ? 'не указан' : vat.exempt ? VAT_EXEMPT_TEXT : `${String(vat.rate).replace('.', ',')} %`)

// Поле НДС среди полей анкеты и ответ на него.
export const vatField = (fields) => (fields || []).find((f) => f.code === VAT_FIELD_CODE) || null
export function vatFromAnswers(fields, answers) {
  const f = vatField(fields)
  return f ? parseVatAnswer(answers?.[f.id]) : null
}

// Варианты списка из текста администратора: по строке или через «;». Пустые и повторы — мимо, не больше 50.
export function parseOptions(text) {
  const out = []
  for (const part of String(text ?? '').split(/\n|;/)) {
    const v = part.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (v && !out.includes(v)) out.push(v)
    if (out.length >= 50) break
  }
  return out
}

// Ответ подходит полю: у списка — только один из вариантов (пусто — можно, это «убрать ответ»).
export function answerAllowed(field, value) {
  const v = String(value ?? '').trim()
  if (!v || field?.kind !== 'select') return true
  return Array.isArray(field.options) && field.options.includes(v)
}
