// Очистка пользовательского текста перед записью в Postgres.
//
// Текст, вставленный из Word / Excel / 1C / PDF, регулярно приносит служебные
// символы, которые Postgres принять не может ни в TEXT, ни в JSONB:
//   • NUL (U+0000) и прочие управляющие символы → 400 «unsupported Unicode
//     escape sequence» (SQLSTATE 22P05) на уровне PostgREST;
//   • одиночные суррогаты (обрезанная копипаста эмодзи) → невалидный UTF-8.
// Внешне текст выглядит нормальным, поэтому пользователь видит только «Ошибка
// сохранения», не понимая причины. Вырезаем такие символы на клиенте.

const TAB = 0x09
const LF = 0x0a
const CR = 0x0d
const DEL = 0x7f
const SURROGATE_FIRST = 0xd800
const SURROGATE_LAST = 0xdfff

// Очистить строку. Не-строки и null/undefined возвращаются как есть.
// for...of идёт по код-поинтам: корректная суррогатная пара приходит целиком
// (эмодзи сохраняется), а «осиротевший» суррогат — одиночным символом.
export function sanitizeUserText(value) {
  if (typeof value !== 'string') return value
  let out = ''
  for (const ch of value) {
    const code = ch.codePointAt(0)
    if (code < 0x20 && code !== TAB && code !== LF && code !== CR) continue
    if (code === DEL) continue
    if (code >= SURROGATE_FIRST && code <= SURROGATE_LAST) continue
    out += ch
  }
  return out
}

// Рекурсивная очистка для JSONB-полей (old_value / new_value в аудит-логе):
// строки чистим, объекты и массивы обходим, остальное отдаём без изменений.
export function sanitizeDeep(value) {
  if (typeof value === 'string') return sanitizeUserText(value)
  if (Array.isArray(value)) return value.map(sanitizeDeep)
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v)
    return out
  }
  return value
}
