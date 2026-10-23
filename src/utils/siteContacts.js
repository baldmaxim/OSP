// Контакт площадки (object_site_contacts, миграция 20261030) и шаблон письма подрядчикам
// без обращения к базе: кого ставить в письмо, вид контакта, ссылка на Telegram, проверка
// формы, дополнение сохранённых шаблонов. Их проверяет и тест без браузера —
// tests/tender/site-contacts.test.mjs. Чтение и запись — services/siteContacts.js,
// вкладка — components/SiteContactsTab.jsx.

// Переменная шаблона письма и строка, в которой она стоит. Строка идёт сразу после
// «…по какому тендеру и объекту обращаетесь.» — с новой строки, как просил отдел.
export const SITE_CONTACT_VAR = '{site_contact}'
export const SITE_CONTACT_LINE = `Если потребуется выезд на объект, предоставляем контактные данные для связи: ${SITE_CONTACT_VAR}`
const SITE_CONTACT_ANCHOR = 'по какому тендеру и объекту обращаетесь.'

// Подразделению контакт не назначен и у объекта нет руководителя строительства: письмо
// всё равно формируется, инженер видит предупреждение и вписывает контакт сам.
export const SITE_CONTACT_MISSING = '[контакт площадки не указан]'

// Почта для вопросов подрядчиков — общий ящик отдела, а не почта ответственного
// (телефон в письме — по-прежнему ответственного).
export const TENDER_MAILBOX = 'tender.osp@su10.ru'

// Что подрядчику сделать с тендерной документацией — между «Приложение:» и ссылкой.
export const ATTACHMENT_NOTE = [
  'Просим внимательно изучить вкладку «Главный лист», заполнить информацию о вашей компании и ознакомиться с предлагаемыми нами условиями сотрудничества.',
  'На вкладках «Материалы» и «Работы» необходимо указать ваши расценки.',
  'Лист «КП» представлен для общего ознакомления и понимания структуры предложения. Вносить в него изменения не нужно.',
].join('\n')
export const ATTACHMENT_BLOCK = `Приложение:\n${ATTACHMENT_NOTE}\nСсылка на тендерную документацию:`
const OLD_ATTACHMENT_LINE = 'Приложение: ссылка на тендерную документацию:'

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

// Ссылка «позвонить» — по первому номеру (их бывает несколько через запятую или «;»), без
// добавочного («доб. 12» набирается уже после ответа).
export function phoneHref(value) {
  const first = String(value || '').split(/[,;]|доб|вн\.|ext/i)[0].trim()
  const digits = first.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '')
  return digits.replace(/\D/g, '').length >= 6 ? `tel:${digits}` : null
}

// «Иванов Иван Иванович, тел. +7 777 123-45-67» — то, что уходит в письмо. Telegram в
// письмо не идёт (решение отдела 21.10): он для своих, во вкладке.
export function formatSiteContact(contact) {
  if (!contact) return ''
  const name = String(contact.full_name || '').trim()
  const phone = String(contact.phone || '').trim()
  return [name, phone && `тел. ${phone}`].filter(Boolean).join(', ')
}

// Кого ставить в письмо и показывать во вкладке. own — контакт подразделения
// (строка object_site_contacts) или null; managers — руководители строительства объекта
// («Общая информация → Объекты», object_staff), их бывает несколько.
// Пустое подразделение временно закрывает руководитель строительства; нет и его —
// письмо формируется с пометкой SITE_CONTACT_MISSING.
// → { source: 'division' | 'manager' | 'none', people, text }
export function pickSiteContact(own, managers = []) {
  if (own) return { source: 'division', people: [own], text: formatSiteContact(own) }
  const people = (managers || []).filter(m => String(m?.full_name || '').trim())
  if (people.length) return { source: 'manager', people, text: people.map(formatSiteContact).join('; ') }
  return { source: 'none', people: [], text: SITE_CONTACT_MISSING }
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

// Сохранённый раньше шаблон получает то, что добавлено в шаблон по умолчанию, — правки
// пользователя остаются: строку о выезде на объект, общий ящик вместо почты
// ответственного, пояснение к тендерной документации. Повтор ничего не меняет.
export function upgradeLetterTemplate(template) {
  const text = String(template || '')
  if (!text) return text
  return addAttachmentNote(addSiteContactLine(text).replaceAll('{employee_email}', TENDER_MAILBOX))
}

// Строка о выезде — сразу после «…по какому тендеру и объекту обращаетесь.». Предложения
// в шаблоне нет (его переписали) — перед подписью «Мы рассчитываем…», нет и её — в конец.
function addSiteContactLine(text) {
  if (text.includes(SITE_CONTACT_VAR)) return text
  const at = text.indexOf(SITE_CONTACT_ANCHOR)
  if (at >= 0) {
    const end = at + SITE_CONTACT_ANCHOR.length
    return `${text.slice(0, end)}\n${SITE_CONTACT_LINE}${text.slice(end)}`
  }
  const closing = text.indexOf('Мы рассчитываем')
  if (closing >= 0) return `${text.slice(0, closing)}${SITE_CONTACT_LINE}\n\n${text.slice(closing)}`
  return `${text.replace(/\s+$/, '')}\n\n${SITE_CONTACT_LINE}`
}

// Пояснение — вместо «Приложение: ссылка на тендерную документацию:»; строки нет —
// перед строкой со ссылкой на тендерный пакет.
function addAttachmentNote(text) {
  if (text.includes(ATTACHMENT_NOTE.split('\n')[0])) return text
  if (text.includes(OLD_ATTACHMENT_LINE)) return text.replace(OLD_ATTACHMENT_LINE, ATTACHMENT_BLOCK)
  const link = text.indexOf('{tender_package_link}')
  if (link < 0) return text
  const lineStart = text.lastIndexOf('\n', link) + 1
  return `${text.slice(0, lineStart)}${ATTACHMENT_NOTE}\n${text.slice(lineStart)}`
}

// Подстановка контакта. contactText = null — у тендера контакта площадки не бывает
// (гарантийный отдел, совместные, прочее): строка с переменной убирается из письма
// целиком; пустой абзац на её месте не остаётся.
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
