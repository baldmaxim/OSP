// Правила полей регистрации подрядчика на сайте — одни для страницы и службы (копия в server/osp-api/src/shared,
// scripts/sync-osp-api-shared.mjs). Страница проверяет для удобства, решает сервер.
//
// Что и почему строже обычной формы:
//   • ИНН — только цифры, контрольная сумма, длина по форме организации, если она известна (10 — организация, 12 — ИП и СЗ);
//     ключ всех дальнейших проверок (ЧС, реестр); КПП — 9 знаков, в 5–6 знаках ФНС допускает латинские буквы;
//   • название — без управляющих знаков, адресов и знаков в начале, которые Excel читает как формулу: оно попадает в реестр
//     контрагентов, выгрузки и CSV API;
//   • почта — обычный адрес без кавычек и комментариев (в заголовок письма ничего постороннего не попадёт), временные
//     почтовые службы не принимаются;
//   • длины ограничены: тело запроса разбирается до обращения к базе.
import { PHONE_EXT_MAX, joinPhoneExt, splitPhoneExt } from './phoneFormat.js'

export const SIGNUP_LIMITS = {
  email: 100,
  emailLocal: 64,
  companyMin: 2,
  // С формой («ФГУП ») — не длиннее 300, как ограничение osp_auth.registrations.company_name.
  company: 295,
  personMin: 2,
  person: 200,
  phoneRaw: 40,
  phoneNumber: 10,
  kpp: 9,
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

// Что набрано в поле КПП → только то, что может там стоять: цифры, в 5–6 знаках ещё заглавные латинские буквы. Русские буквы,
// похожие на латинские, — как латинские: в реквизитах их пишут и так, а база примет только латиницу.
const KPP_LOOKALIKE = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X' }
export function cleanKppInput(raw) {
  let out = ''
  for (const typed of String(raw ?? '').toUpperCase()) {
    if (out.length === SIGNUP_LIMITS.kpp) break
    const ch = KPP_LOOKALIKE[typed] ?? typed
    if (/\d/.test(ch) || (/[A-Z]/.test(ch) && (out.length === 4 || out.length === 5))) out += ch
  }
  return out
}

// ── Форма организации ───────────────────────────────────────────────────────────────────────────────
// Решение пользователя 05.11: подрядчик ничего не выбирает, форма определяется сама. Название пишут как привыкли — форму на копии
// реестра 15.10 пишут только в начале (1172 компании из 1854, в конце — ни одной), поэтому она берётся оттуда (splitLegalForm).
// В заявке и реестре — вместе: «ООО Ромашка». Формы не назвали — по ИНН (guessLegalForm), список на странице — чтобы поправить.
// СЗ — самозанятый. ИНН из 10 цифр у организации (есть КПП), из 12 — у физического лица. Частые формы — первыми.
export const LEGAL_FORMS = [
  { code: 'ООО', innLength: 10, words: 'ооо|ooo|общество\\s+с\\s+ограниченной\\s+ответственностью' },
  { code: 'ИП', innLength: 12, words: 'ип|индивидуальный\\s+предприниматель' },
  { code: 'СЗ', innLength: 12, words: 'сз|самозанят(?:ый|ая)' },
  { code: 'АО', innLength: 10, words: 'ао|ao|акционерное\\s+общество' },
  { code: 'ПАО', innLength: 10, words: 'пао|публичное\\s+акционерное\\s+общество' },
  { code: 'ЗАО', innLength: 10, words: 'зао|закрытое\\s+акционерное\\s+общество' },
  { code: 'ОАО', innLength: 10, words: 'оао|открытое\\s+акционерное\\s+общество' },
  { code: 'НАО', innLength: 10, words: 'нао|непубличное\\s+акционерное\\s+общество' },
  { code: 'АНО', innLength: 10, words: 'ано|автономная\\s+некоммерческая\\s+организация' },
  { code: 'ГУП', innLength: 10, words: 'гуп|государственное\\s+унитарное\\s+предприятие' },
  { code: 'МУП', innLength: 10, words: 'муп|муниципальное\\s+унитарное\\s+предприятие' },
  { code: 'ФГУП', innLength: 10, words: 'фгуп|федеральное\\s+государственное\\s+унитарное\\s+предприятие' },
  { code: 'ГБУ', innLength: 10, words: 'гбу|государственное\\s+бюджетное\\s+учреждение' },
]
export const legalFormOf = (code) => LEGAL_FORMS.find((f) => f.code === code) ?? null

const QUOTES = '"«»„“”\''
const FORM_AT_START = LEGAL_FORMS.map((f) => ({ code: f.code, re: new RegExp(`^\\s*(?:${f.words})(?:\\s+|(?=[${QUOTES}]))`, 'iu') }))

// Форма в начале набранного → { form, name } или null. Слово должно быть закончено: «ИПотека» и ещё не дописанное «ООО» — не форма.
export function splitLegalForm(text) {
  const s = String(text ?? '')
  for (const f of FORM_AT_START) {
    const m = f.re.exec(s)
    if (m) return { form: f.code, name: s.slice(m[0].length) }
  }
  return null
}

// Форма по ИНН, если её не назвали. Точно по ИНН её не узнать, только самую частую: 12 цифр — ИП, 10 — ООО (на копии реестра 15.10,
// среди компаний с формой и ИНН, — 99 % и 94 %). Догадка страницы: человек видит её рядом с названием и может сменить. Служба сама
// по ИНН форму не ставит.
export const guessLegalForm = (inn) => ({ 10: 'ООО', 12: 'ИП' })[String(inn ?? '').length] ?? ''

// Какие формы могут быть при таком ИНН: при 12 цифрах остаются только ИП и СЗ.
export function legalFormsForInn(inn) {
  const length = String(inn ?? '').length
  return length === 10 || length === 12 ? LEGAL_FORMS.filter((f) => f.innLength === length) : LEGAL_FORMS
}

// Форма и название из заявки → { legal, name } или null, если такой формы нет. legalForm: код формы; '' — человек убрал форму,
// название как есть; не передан — по самому названию. Название целиком: форма может быть и единственным словом («ООО»).
function parseCompany(legalForm, rawName) {
  const name = clean(rawName)
  if (legalForm === '') return { legal: null, name }
  const named = splitLegalForm(`${name} `)
  if (legalForm === undefined || legalForm === null) return named ? { legal: legalFormOf(named.form), name: clean(named.name) } : { legal: null, name }
  const legal = legalFormOf(legalForm)
  if (!legal) return null
  return { legal, name: named?.form === legal.code ? clean(named.name) : name }
}

// ── Телефон ─────────────────────────────────────────────────────────────────────────────────────────
export const PHONE_PROBLEM = 'Проверьте телефон: после +7 — 10 цифр, например 916 123-45-67'

// → «+79161234567», с добавочным «+79161234567 доб. 123» (запись как в phoneFormat.js) или null. 8 и 7 в начале российского номера —
// одно и то же; другие страны — только с «+». После «+7» — ровно 10 цифр.
export function normalizePhone(raw) {
  const text = String(raw ?? '').trim()
  if (!text || text.length > SIGNUP_LIMITS.phoneRaw) return null
  const { number, ext } = splitPhoneExt(text)
  if (ext.length > PHONE_EXT_MAX || !/^[+\d\s()\-.]+$/.test(number)) return null
  const digits = digitsOnly(number)
  const plus = number.startsWith('+')
  let main = null
  if (digits.length === 10 && !plus) main = `+7${digits}`
  else if (digits.length === 11 && /^[78]/.test(digits) && !(plus && digits[0] === '8')) main = `+7${digits.slice(1)}`
  else if (plus && digits[0] !== '7' && digits.length >= 8 && digits.length <= 15 && digits[0] !== '0') main = `+${digits}`
  return main && joinPhoneExt(main, ext)
}

// Последние 10 цифр номера без добавочного — для сравнения с контактами.
export const phoneMainDigits = (phone) => digitsOnly(splitPhoneExt(phone).number).slice(-10)

// Что набрано в поле номера после «+7» → { number: до 10 цифр, ext }. Добавочный — если вставили номер вместе с ним.
// Первые 7 и 8 — по привычке или из вставленного номера: 89… и 79… — сразу (таких кодов нет), остальные — когда цифр больше 10:
// 812 и 701 — настоящие коды. Лишняя цифра в конце не сдвигает номер: кода на 1 и 2 нет, поэтому 812… + цифра остаётся 812….
export function parsePhoneInput(raw) {
  const { number, ext } = splitPhoneExt(raw)
  const digits = digitsOnly(number)
  const trunk = /^[78]9/.test(digits) || (digits.length > SIGNUP_LIMITS.phoneNumber && /^[78][3-8]/.test(digits))
  return { number: (trunk ? digits.slice(1) : digits).slice(0, SIGNUP_LIMITS.phoneNumber), ext: ext.slice(0, PHONE_EXT_MAX) }
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
  if (e.length > SIGNUP_LIMITS.email) return `Адрес почты — не длиннее ${SIGNUP_LIMITS.email} знаков`
  if (!e.includes('@')) return 'В адресе почты нужен знак @: например, ivanov@company.ru'
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
    .replace(/(^|[\s"«»„“”'])(ооо|оао|зао|пао|ао|нао|ано|гуп|муп|фгуп|гбу|ип|сз|тоо|общество с ограниченной ответственностью|публичное акционерное общество|закрытое акционерное общество|открытое акционерное общество|непубличное акционерное общество|акционерное общество|индивидуальный предприниматель|самозанятый|самозанятая)(?=$|[\s"«»„“”'])/gu, ' ')
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
  const company = parseCompany(input?.legalForm, input?.companyName)
  if (!company) return fail('companyName', 'Неизвестная форма организации')
  const { legal, name } = company
  const companyProblem = companyNameProblem(name)
  if (companyProblem) return fail('companyName', companyProblem)
  const inn = String(input?.inn ?? '').replace(/\s+/g, '')
  if (!inn) return fail('inn', 'Укажите ИНН')
  if (/\D/.test(inn)) return fail('inn', 'В ИНН — только цифры')
  if (legal && inn.length !== legal.innLength) return fail('inn', `ИНН у ${legal.code} — ${legal.innLength} цифр`)
  if (!isValidInn(inn)) return fail('inn', 'ИНН не прошёл проверку: 10 цифр у организации, 12 у ИП и самозанятых')
  const kpp = String(input?.kpp ?? '').trim().toUpperCase()
  if (kpp && inn.length === 12) return fail('kpp', 'У ИП и самозанятых нет КПП')
  if (kpp && !isValidKpp(kpp)) return fail('kpp', 'КПП — 9 знаков, например 770101001')
  const nameProblem = personNameProblem(input?.contactName)
  if (nameProblem) return fail('contactName', nameProblem)
  const phone = normalizePhone(input?.phone)
  if (!phone) return fail('phone', PHONE_PROBLEM)
  if (input?.consent !== true) return fail('consent', 'Нужно согласие на обработку персональных данных')
  return {
    ok: true,
    value: { email, companyName: legal ? `${legal.code} ${name}` : name, inn, kpp: kpp || null, contactName: clean(input.contactName), phone },
  }
}
