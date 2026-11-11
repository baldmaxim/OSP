// Анкета участника и «Моя компания» — одни сведения (миграция 20270115, просьба пользователя 11.11.2026: «должно автоматом
// состыковываться информация из „Моей компании“ и то, что заполняется под тендером; в дальнейшем будут создаваться или убираться
// поля и там и там»). Правила без базы и без React.
//
// Поле анкеты (bid_form_fields):
//  • по тендеру (scope = 'tender') — свой ответ в каждом тендере, как раньше;
//  • о компании (scope = 'company') — ответ один на организацию (bid_company_answers): заполняется один раз — в анкете любого тендера
//    или в «Моей компании» — и сам стоит в анкете каждого тендера;
//  • связанное со сведением карточки компании (source) — тоже о компании: ответ берётся из карточки (её ведёт отдел), в анкете его не
//    поменять. В карточке пусто — подрядчик отвечает сам, как на поле о компании.
//
// Перечень сведений карточки — COMPANY_SOURCES ниже: одно место для «Моей компании», анкеты и «Полей анкеты» администратора. Новое
// сведение карточки (новая колонка contractor_org_card) — строка здесь, и его можно связать с полем; сведение убрали из перечня —
// связанное поле становится обычным полем о компании, ответы не теряются. Поле анкеты администратор добавляет и убирает сам.
import { headKind, HEAD_KINDS } from './counterpartyHead.js'
import { formatPercent } from './counterpartyVat.js'

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const join = (...parts) => parts.map(clean).filter(Boolean).join(', ')

// Руководитель компании — контакт карточки с должностью руководителя (как подпись в «Заявке на ДС», counterpartyHead.js).
export function companyHead(card) {
  let best = null
  for (const c of Array.isArray(card?.contacts) ? card.contacts : []) {
    const kind = headKind(c?.position)
    if (!kind || !clean(c.full_name)) continue
    if (!best || HEAD_KINDS[kind].rank < HEAD_KINDS[best.kind].rank) best = { kind, contact: c }
  }
  return best?.contact || null
}

// Ставка НДС карточки текстом варианта анкеты: «22 %», «Без НДС»; не указана — null.
export function companyVatText(card) {
  if (card?.vat_exempt) return 'Без НДС'
  if (card?.vat_rate == null || card.vat_rate === '') return null
  const n = Number(card.vat_rate)
  return Number.isFinite(n) ? `${formatPercent(n)} %` : null
}

// Сведения карточки, с которыми можно связать поле анкеты. value(card) — ответ текстом или пусто.
export const COMPANY_SOURCES = [
  { key: 'name', label: 'Название', short: 'название', value: (c) => clean(c?.name) },
  { key: 'inn', label: 'ИНН', short: 'ИНН', value: (c) => clean(c?.inn) },
  { key: 'kpp', label: 'КПП', short: 'КПП', value: (c) => clean(c?.kpp) },
  {
    key: 'address', label: 'Адрес (юр. и факт.)', short: 'адрес', value: (c) => {
      const legal = clean(c?.legal_address)
      const actual = clean(c?.actual_address)
      if (legal && actual && legal.toLowerCase() !== actual.toLowerCase()) return `юр.: ${legal}; факт.: ${actual}`
      return legal || actual
    },
  },
  { key: 'legal_address', label: 'Юридический адрес', short: 'юридический адрес', value: (c) => clean(c?.legal_address) },
  { key: 'actual_address', label: 'Фактический адрес', short: 'фактический адрес', value: (c) => clean(c?.actual_address) },
  { key: 'website', label: 'Сайт', short: 'сайт', value: (c) => clean(c?.website) },
  { key: 'work_type', label: 'Виды работ', short: 'виды работ', value: (c) => clean(c?.work_type) },
  { key: 'vat', label: 'Ставка НДС', short: 'ставка НДС', value: (c) => companyVatText(c) || '' },
  {
    key: 'director', label: 'Руководитель: ФИО, тел., e-mail', short: 'руководитель', value: (c) => {
      const h = companyHead(c)
      return h ? join(h.full_name, h.phone, h.email) : ''
    },
  },
  { key: 'contact', label: 'Контактное лицо (кто вошёл): ФИО, тел., e-mail', short: 'контактное лицо', value: (c) => join(c?.contact_name, c?.contact_phone, c?.contact_email) },
  { key: 'email', label: 'Почта для входа', short: 'почта', value: (c) => clean(c?.contact_email) },
  { key: 'phone', label: 'Телефон (кто вошёл)', short: 'телефон', value: (c) => clean(c?.contact_phone) },
]
const SOURCE_BY_KEY = new Map(COMPANY_SOURCES.map((s) => [s.key, s]))
export const sourceOf = (field) => (field?.source ? SOURCE_BY_KEY.get(field.source) || null : null)

export const FIELD_SCOPES = { tender: 'По тендеру — свой ответ в каждом тендере', company: 'О компании — один ответ, подставляется в каждый тендер' }

// Поле о компании: вид «о компании» или связано с карточкой (в том числе со сведением, которого в перечне больше нет).
export const isCompanyField = (f) => !!f && (f.scope === 'company' || !!f.source)

// Ответ подходит полю: у списка — только один из вариантов.
const fits = (field, value) => !!value && (field.kind !== 'select' || (Array.isArray(field.options) && field.options.includes(value)))

// Ответ из карточки: связанное поле, в карточке есть значение, и оно подходит полю. → текст или null.
export function cardValue(field, card) {
  const src = sourceOf(field)
  if (!src || !card) return null
  const v = src.value(card)
  return fits(field, v) ? v : null
}

// Что стоит в поле о компании и откуда: { value, from: 'card' | 'company' | null, locked, cardRaw }.
//   card — из карточки, в анкете не меняется; company — ответ организации; null — ответа нет.
//   cardRaw — значение карточки, которое полю не подошло (ставка «Без НДС», которой нет в списке анкеты) — чтобы сказать об этом.
export function companyFieldState(field, card, companyAnswers) {
  const fromCard = cardValue(field, card)
  if (fromCard) return { value: fromCard, from: 'card', locked: true, cardRaw: null }
  const src = sourceOf(field)
  const raw = src && card ? src.value(card) : ''
  // Ответ организации, который полю больше не подходит (администратор поменял варианты списка), — как нет ответа.
  const own = clean(companyAnswers?.[field.id]?.value)
  const ok = own && fits(field, own)
  return { value: ok ? own : '', from: ok ? 'company' : null, locked: false, cardRaw: raw && !fits(field, raw) ? raw : null }
}

// Ответы анкеты тендера, которые видит подрядчик: ответы тендера, а у полей о компании — карточка и ответы организации.
// companyAnswers = null — таблицы ответов о компании нет: связь с карточкой работает, остальное — ответ тендера, как раньше.
// У поля о компании без ответа (ни в карточке, ни у организации) остаётся ответ тендера.
// → { answers: { id: значение }, patch: { id: значение } } — patch: что записать в анкету тендера, чтобы она совпала с «Моей компанией»
// (анкета тендера — то, что видит отдел).
export function effectiveAnswers(fields, tenderAnswers, card, companyAnswers) {
  const answers = { ...(tenderAnswers || {}) }
  const patch = {}
  for (const f of fields || []) {
    if (!isCompanyField(f)) continue
    const { value } = companyFieldState(f, card, companyAnswers)
    if (!value || clean(answers[f.id]) === value) continue
    answers[f.id] = value
    patch[f.id] = value
  }
  return { answers, patch }
}

// Поля анкеты → группы для показа: сначала о компании, затем по тендеру; порядок внутри — как у администратора.
export function fieldGroups(fields) {
  const list = fields || []
  return {
    company: list.filter(isCompanyField),
    tender: list.filter((f) => !isCompanyField(f)),
  }
}
