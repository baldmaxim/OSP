// Имена файлов и папок, допустимые в Windows. Общие для «Скачать всё» у участников
// тендера (utils/tenderFilesArchive.js) и скачивания КП в «Проверке КП»
// (utils/kpDownloadName.js); отдельный модуль — чтобы страницы не тянули за ними ZIP.
// Проверяет tests/tender/files-archive.test.mjs.

export const FILE_NAME_MAX = 80

const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const FORBIDDEN_CHAR = /[\\/:*?<>|]/g
const EXTENSION = /\.[^.\s]{1,10}$/

function stripControl(text) {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)
    out += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  return out
}

// Обрезка по границе слова с «…»; слово режется, только если пробел слишком далеко.
function cutText(text, max) {
  if (text.length <= max) return text
  const head = text.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  const cut = space >= max * 0.6 ? head.slice(0, space) : head
  return cut.replace(/[\s.,;:–—-]+$/, '') + '…'
}

// Имя папки или файла, допустимое в Windows: без \ / : * ? " < > | и управляющих
// символов, без точек и пробелов в конце, не CON/NUL/…, не длиннее max.
export function safeName(value, { max = FILE_NAME_MAX, fallback = 'Без названия' } = {}) {
  const clean = stripControl(String(value ?? ''))
    .replace(/"/g, "'")
    .replace(FORBIDDEN_CHAR, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  let name = cutText(clean, max).replace(/[. ]+$/, '')
  if (!name) name = fallback
  if (RESERVED_NAME.test(name.split('.')[0])) name = `_${name}`
  return name
}

export function splitExtension(fileName) {
  const match = fileName.match(EXTENSION)
  if (!match || match.index === 0) return [fileName, '']
  return [fileName.slice(0, match.index), match[0]]
}

// То же для файла: расширение сохраняется, обрезается только имя.
export function safeFileName(value, max = FILE_NAME_MAX) {
  const [base, ext] = splitExtension(safeName(value, { max: Number.MAX_SAFE_INTEGER, fallback: 'Файл' }))
  return safeName(base, { max: Math.max(max - ext.length, 8), fallback: 'Файл' }) + ext
}
