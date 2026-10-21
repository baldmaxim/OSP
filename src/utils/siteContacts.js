// Контакт площадки (object_site_contacts, миграция 20261030) без обращения к базе: вид в
// письме подрядчикам, ссылка на Telegram, проверка формы и строка письма о выезде на
// объект. Их проверяет и тест без браузера — tests/tender/site-contacts.test.mjs.
// Чтение и запись — services/siteContacts.js, вкладка — components/SiteContactsTab.jsx.

// Переменная шаблона письма и строка, в которой она стоит. Строка идёт сразу после
// «…по какому тендеру и объекту обращаетесь.» — с новой строки, как просил отдел.
export const SITE_CONTACT_VAR = '{site_contact}'
export const SITE_CONTACT_LINE = `Если потребуется выезд на объект, предоставляем контактные данные для связи: ${SITE_CONTACT_VAR}`
const SITE_CONTACT_ANCHOR = 'по какому тендеру и объекту обращаетесь.'

export const SITE_CONTACT_LIMITS = { full_name: 200, phone: 100, telegram: 200 }

// Имя Telegram: 5–32 латинских буквы, цифры и подчёркивание (как требует сам Telegram).
const TG_USERNAME = /^@?([A-Za-z][A-Za-z0-9_]{4,31})$/
const TG_LINK = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/i

// Как показывать Telegram: имя — с «@», ссылку t.me — именем; прочее (номер) — как ввели.
export function telegramLabel(value) {
  const v = String(value || '').trim()
  if (!v) return ''
  const m = v.match(TG_USERNAME) || v.match(TG_LINK)
  return m ? `@${m[1]}` : v
}

// Ссылка на профиль — только когда введено имя или ссылка t.me; номер телефона не ссылка.
export function telegramHref(value) {
  const v = String(value || '').trim()
  const m = v.match(TG_USERNAME) || v.match(TG_LINK)
  return m ? `https://t.me/${m[1]}` : null
}

// Ссылка «позвонить» — по первому номеру (их бывает несколько через запятую или «;»).
export function phoneHref(value) {
  const first = String(value || '').split(/[,;]/)[0].trim()
  const digits = first.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '')
  return digits.replace(/\D/g, '').length >= 6 ? `tel:${digits}` : null
}

// «Иванов Иван Иванович, тел. +7 777 123-45-67, Telegram: @ivanov» — то, что уходит в письмо.
export function formatSiteContact(contact) {
  if (!contact) return ''
  const parts = [String(contact.full_name || '').trim()]
  const phone = String(contact.phone || '').trim()
  if (phone) parts.push(`тел. ${phone}`)
  const tg = telegramLabel(contact.telegram)
  if (tg) parts.push(`Telegram: ${tg}`)
  return parts.filter(Boolean).join(', ')
}

// Черновик формы → { value, error }. ФИО и телефон обязательны: без них подрядчику
// некого и некуда звать; Telegram — по желанию.
export function validateSiteContact(draft) {
  const value = {
    full_name: String(draft?.full_name || '').trim(),
    phone: String(draft?.phone || '').trim(),
    telegram: String(draft?.telegram || '').trim(),
  }
  if (!value.full_name) return { value, error: 'Укажите ФИО' }
  if (!value.phone) return { value, error: 'Укажите номер телефона' }
  for (const [key, max] of Object.entries(SITE_CONTACT_LIMITS)) {
    if (value[key].length > max) return { value, error: `Слишком длинное значение (до ${max} символов)` }
  }
  return { value: { ...value, telegram: value.telegram || null }, error: null }
}

// Шаблон, сохранённый до появления контакта площадки, получает строку о выезде сразу
// после «…по какому тендеру и объекту обращаетесь.» — правки пользователя остаются.
// Предложения в шаблоне нет (его переписали) — строка встаёт перед подписью
// «Мы рассчитываем…», а нет и её — в конец.
export function upgradeLetterTemplate(template) {
  const text = String(template || '')
  if (!text || text.includes(SITE_CONTACT_VAR)) return text
  const at = text.indexOf(SITE_CONTACT_ANCHOR)
  if (at >= 0) {
    const end = at + SITE_CONTACT_ANCHOR.length
    return `${text.slice(0, end)}\n${SITE_CONTACT_LINE}${text.slice(end)}`
  }
  const closing = text.indexOf('Мы рассчитываем')
  if (closing >= 0) return `${text.slice(0, closing)}${SITE_CONTACT_LINE}\n\n${text.slice(closing)}`
  return `${text.replace(/\s+$/, '')}\n\n${SITE_CONTACT_LINE}`
}

// Подстановка контакта. contactText = null — у тендера контакта площадки не бывает
// (гарантийный отдел, совместные, прочее) или база ещё без таблицы: строка с
// переменной убирается из письма целиком; пустой абзац на её месте не остаётся.
export function fillSiteContact(text, contactText) {
  const src = String(text || '')
  if (contactText) return src.replaceAll(SITE_CONTACT_VAR, contactText)
  if (!src.includes(SITE_CONTACT_VAR)) return src
  return src
    .split('\n')
    .filter(line => !line.includes(SITE_CONTACT_VAR))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}
