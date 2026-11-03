// Правила полей регистрации подрядчика на сайте — одни для страницы и службы (копия в server/osp-api/src/shared,
// scripts/sync-osp-api-shared.mjs). Страница проверяет для удобства, решает сервер.
//
// Что и почему строже обычной формы:
//   • ИНН — контрольная сумма (10 цифр — организация, 12 — ИП); ключ всех дальнейших проверок (ЧС, реестр);
//   • название — без управляющих знаков, без адресов и без знаков в начале, которые Excel читает как формулу: оно
//     попадает в реестр контрагентов, выгрузки и CSV API;
//   • почта — обычный адрес без кавычек и комментариев (в заголовок письма ничего постороннего не попадёт), временные
//     почтовые службы не принимаются;
//   • длины ограничены: тело запроса разбирается до обращения к базе.
export const SIGNUP_LIMITS = {
  email: 254,
  emailLocal: 64,
  companyMin: 2,
  company: 300,
  personMin: 2,
  person: 200,
  phoneRaw: 40,
  passwordMin: 15,
  password: 128,
}

// Версия текста согласия на обработку персональных данных: в заявке — какой текст человек принял.
export const SIGNUP_CONSENT_VERSION = '2026-11-03'

// Управляющие и невидимые знаки (нулевой ширины, смена направления текста — подмена названия при показе).
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u
const clean = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()

export const digitsOnly = (s) => String(s ?? '').replace(/\D+/g, '')

// ── ИНН и КПП ───────────────────────────────────────────────────────────────────────────────────────
const innSum = (digits, weights) => weights.reduce((sum, w, i) => sum + w * digits[i], 0) % 11 % 10

// Контрольная сумма ИНН. Все нули и код региона 00 сумму проходят, но ИНН таким не бывает.
export function isValidInn(value) {
  const s = String(value ?? '')
  if (!/^\d{10}$|^\d{12}$/.test(s) || s.startsWith('00')) return false
  const d = [...s].map(Number)
  if (s.length === 10) return innSum(d, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9]
  return innSum(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10]
    && innSum(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11]
}

export const isValidKpp = (value) => /^\d{4}[\dA-Z]{2}\d{3}$/.test(String(value ?? '')) && !/^0+$/.test(String(value))

// ── Телефон ─────────────────────────────────────────────────────────────────────────────────────────
// → «+79161234567» или null. 8 и 7 в начале российского номера — одно и то же; другие страны — только с «+».
export function normalizePhone(raw) {
  const text = String(raw ?? '').trim()
  if (!text || text.length > SIGNUP_LIMITS.phoneRaw || !/^[+\d\s()\-.]+$/.test(text)) return null
  const digits = digitsOnly(text)
  if (digits.length === 10 && !text.startsWith('+')) return `+7${digits}`
  if (digits.length === 11 && /^[78]/.test(digits) && !(text.startsWith('+') && digits[0] === '8')) return `+7${digits.slice(1)}`
  if (text.startsWith('+') && digits.length >= 8 && digits.length <= 15 && digits[0] !== '0') return `+${digits}`
  return null
}

// ── Почта ───────────────────────────────────────────────────────────────────────────────────────────
const EMAIL = /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9_%+-])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/

// Временные почтовые службы: подтверждение почты на них ничего не доказывает.
const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', '20minutemail.com', 'anonaddy.com', 'burnermail.io', 'cock.li', 'discard.email',
  'dispostable.com', 'dropmail.me', 'emailondeck.com', 'fakeinbox.com', 'getairmail.com', 'getnada.com', 'grr.la',
  'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.info', 'guerrillamail.net', 'guerrillamail.org', 'harakirimail.com',
  'inboxbear.com', 'inboxkitten.com', 'mail-temp.com', 'mailcatch.com', 'maildrop.cc', 'mailinator.com', 'mailnesia.com',
  'mailsac.com', 'mintemail.com', 'mohmal.com', 'moakt.com', 'mytemp.email', 'nada.email', 'sharklasers.com', 'spam4.me',
  'spamgourmet.com', 'temp-mail.io', 'temp-mail.org', 'temp-mail.ru', 'tempail.com', 'tempmail.com', 'tempmail.dev',
  'tempmail.net', 'tempmailo.com', 'tempr.email', 'throwawaymail.com', 'trashmail.com', 'trashmail.de', 'yopmail.com',
  'yopmail.fr', 'yopmail.net',
])

// Общедоступные почтовые службы: совпадение домена у таких адресов связи между людьми не доказывает.
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yandex.ru', 'ya.ru', 'yandex.com', 'yandex.kz', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru',
  'internet.ru', 'rambler.ru', 'lenta.ru', 'autorambler.ru', 'myrambler.ru', 'ro.ru', 'outlook.com', 'hotmail.com', 'live.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'yahoo.com', 'proton.me', 'protonmail.com', 'pm.me', 'zoho.com', 'gmx.com', 'gmx.de',
])

export const emailDomain = (email) => String(email ?? '').trim().toLowerCase().split('@').pop() || ''
export const isDisposableDomain = (domain) => DISPOSABLE_DOMAINS.has(String(domain ?? '').toLowerCase())
export const isPublicMailDomain = (domain) => PUBLIC_MAIL_DOMAINS.has(String(domain ?? '').toLowerCase())

// → текст замечания или null.
export function emailProblem(email) {
  const e = String(email ?? '').trim()
  if (!e) return 'Укажите почту'
  if (e.length > SIGNUP_LIMITS.email) return 'Слишком длинный адрес почты'
  if (!EMAIL.test(e) || e.includes('..')) return 'Проверьте адрес почты: например, ivanov@company.ru'
  if (e.split('@')[0].length > SIGNUP_LIMITS.emailLocal) return 'Слишком длинный адрес почты'
  if (isDisposableDomain(emailDomain(e))) return 'Временная почта не подойдёт — укажите рабочий адрес'
  return null
}

// ── Названия и имена ────────────────────────────────────────────────────────────────────────────────
const FORMULA_START = /^[=+\-@\t\r]/
const LINK = /:\/\/|\bwww\.|\.(?:ru|com|net|org|рф|su|io)(?:\/|\s|$)/i

export function companyNameProblem(value) {
  const raw = String(value ?? '')
  if (HIDDEN.test(raw.replace(/[\t\r\n]/g, ' '))) return 'В названии есть недопустимые знаки'
  const s = clean(raw)
  if ([...s].length < SIGNUP_LIMITS.companyMin) return 'Укажите название организации'
  if ([...s].length > SIGNUP_LIMITS.company) return `Название — не длиннее ${SIGNUP_LIMITS.company} знаков`
  if (!/\p{L}/u.test(s)) return 'В названии должны быть буквы'
  if (/[<>]/.test(s) || FORMULA_START.test(s)) return 'В названии есть недопустимые знаки'
  if (LINK.test(s)) return 'Адрес сайта в названии не нужен'
  return null
}

export function personNameProblem(value) {
  const raw = String(value ?? '')
  if (HIDDEN.test(raw.replace(/[\t\r\n]/g, ' '))) return 'В имени есть недопустимые знаки'
  const s = clean(raw)
  if ([...s].length < SIGNUP_LIMITS.personMin) return 'Укажите контактное лицо'
  if ([...s].length > SIGNUP_LIMITS.person) return `Имя — не длиннее ${SIGNUP_LIMITS.person} знаков`
  if (!/^\p{L}[\p{L}\p{M} .'’-]*$/u.test(s)) return 'В имени — только буквы, пробел, точка и дефис'
  return null
}

// Для сравнения названий с чёрным списком: без формы собственности, кавычек, пробелов и регистра.
// Латиница, похожая на кириллицу, — как кириллица: иначе «OOO Pомашка» с чужими буквами обошла бы сравнение.
const LOOKALIKE = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' }
export function companyNameKey(value) {
  return clean(value).toLowerCase().replace(/[abcehkmoptxy]/g, (ch) => LOOKALIKE[ch]).replace(/ё/g, 'е')
    .replace(/(^|[\s"«»„“”'])(ооо|оао|зао|пао|ао|нао|ип|тоо|общество с ограниченной ответственностью|акционерное общество|индивидуальный предприниматель)(?=$|[\s"«»„“”'])/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

// Адрес почты в письме — без части перед «@» (показывается человеку, который не обязательно его хозяин).
export function maskEmail(email) {
  const [local = '', domain = ''] = String(email ?? '').split('@')
  return `${local.slice(0, 1)}***@${domain}`
}

// ── Вся форма ───────────────────────────────────────────────────────────────────────────────────────
// → { ok: true, value } либо { ok: false, field, message }. Пароль здесь не проверяется (служба — по своему правилу).
export function validateSignup(input) {
  const fail = (field, message) => ({ ok: false, field, message })
  const email = String(input?.email ?? '').trim()
  const problemEmail = emailProblem(email)
  if (problemEmail) return fail('email', problemEmail)
  const companyProblem = companyNameProblem(input?.companyName)
  if (companyProblem) return fail('companyName', companyProblem)
  const inn = digitsOnly(input?.inn)
  if (!inn) return fail('inn', 'Укажите ИНН')
  if (!isValidInn(inn)) return fail('inn', 'ИНН не прошёл проверку: 10 цифр у организации, 12 у ИП')
  const kpp = String(input?.kpp ?? '').trim().toUpperCase()
  if (kpp && inn.length === 12) return fail('kpp', 'У ИП нет КПП')
  if (kpp && !isValidKpp(kpp)) return fail('kpp', 'КПП — 9 знаков, например 770101001')
  const nameProblem = personNameProblem(input?.contactName)
  if (nameProblem) return fail('contactName', nameProblem)
  const phone = normalizePhone(input?.phone)
  if (!phone) return fail('phone', 'Проверьте телефон: например, +7 916 123-45-67')
  if (input?.consent !== true) return fail('consent', 'Нужно согласие на обработку персональных данных')
  return {
    ok: true,
    value: { email, companyName: clean(input.companyName), inn, kpp: kpp || null, contactName: clean(input.contactName), phone },
  }
}
