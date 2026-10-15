// Правила для НОВЫХ паролей (смена пароля пользователем, временный пароль от администратора) — NIST SP 800-63B-4
// для однофакторного пароля:
//   • нормализация NFC; длина — 15–128 кодовых точек Unicode; правил состава («цифра, заглавная…») нет;
//   • пароль целиком сравнивается со списком распространённых и утёкших (src/data/common-passwords.txt.gz);
//   • пароль целиком сравнивается с производными: почта, её часть до «@», ФИО и его части, слова сервиса — после
//     удаления пробелов и знаков и с отброшенными цифрами в конце («ivanov2025»). Подстроки не ищутся: длинная
//     фраза, в которой встречается имя, допустима.
// Перенесённые из Supabase пароли этим правилам не подчиняются: они продолжают работать как есть.
import fs from 'node:fs'
import { randomInt } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

export const MIN_LENGTH = 15
export const MAX_LENGTH = 128
const SERVICE_WORDS = ['su10', 'су10', 'osp', 'осп', 'tender', 'тендер', 'tendersu10', 'password', 'пароль', 'qwerty', 'йцукен']
// Без похожих знаков (0/O, 1/l/I) — временный пароль диктуют и переписывают.
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
export const TEMP_LENGTH = 20

export const BLOCKLIST_FILE = new URL('../../data/common-passwords.txt.gz', import.meta.url)

export function loadBlocklist(file = BLOCKLIST_FILE) {
  const text = gunzipSync(fs.readFileSync(file)).toString('utf8')
  return new Set(text.split('\n').filter(Boolean))
}

const codePoints = (s) => [...s].length
// Для сравнения с производными: нижний регистр, без пробелов, знаков препинания и символов.
const squash = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
const stripTrailingDigits = (s) => s.replace(/\d+$/u, '')

function derivedValues({ email, fullName } = {}) {
  const out = new Set()
  const add = (v) => {
    const s = squash(v)
    if (s.length >= 3) { out.add(s); out.add(stripTrailingDigits(s)) }
  }
  if (email) {
    add(email)
    add(String(email).split('@')[0])
  }
  if (fullName) {
    add(fullName)
    for (const part of String(fullName).split(/\s+/)) add(part)
  }
  for (const w of SERVICE_WORDS) add(w)
  out.delete('')
  return out
}

// → null, если пароль годится; иначе { code, message } — сообщение для пользователя, без самого пароля.
export function checkNewPassword(password, context = {}, blocklist = new Set()) {
  if (typeof password !== 'string') return { code: 'password_invalid', message: 'Пароль не указан' }
  const p = password.normalize('NFC')
  const n = codePoints(p)
  if (n < MIN_LENGTH) return { code: 'password_too_short', message: `Пароль — не меньше ${MIN_LENGTH} знаков. Удобно взять фразу из нескольких слов.` }
  if (n > MAX_LENGTH) return { code: 'password_too_long', message: `Пароль — не длиннее ${MAX_LENGTH} знаков` }
  if (blocklist.has(p.toLowerCase())) return { code: 'password_common', message: 'Этот пароль слишком распространён — его легко подобрать. Придумайте другой.' }
  const s = squash(p)
  const derived = derivedValues(context)
  if (derived.has(s) || derived.has(stripTrailingDigits(s))) {
    return { code: 'password_personal', message: 'Пароль не должен совпадать с почтой, ФИО или названием портала' }
  }
  return null
}

export function generateTemporaryPassword() {
  let out = ''
  for (let i = 0; i < TEMP_LENGTH; i++) out += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]
  return out
}
