// Безопасный просмотр .docx (docx-preview): файл загружает пользователь, а библиотека переносит из него в страницу как есть
//   • код символа w:sym — через innerHTML (код вида «41;<img onerror=…>» становится разметкой страницы);
//   • адрес внешней ссылки — в href (javascript: выполнялся по нажатию);
//   • вложенный HTML (altChunk) — в iframe без песочницы (отключается параметром renderAltChunks: false).
// Поэтому модель документа чистится между разбором (parseAsync) и отрисовкой (renderDocument): в странице оказывается только
// то, что прошло проверку. Меняете версию docx-preview — проверьте, что эти места не сдвинулись (tests/tender/docx-safe.test.mjs).
const HEX_CHAR = /^[0-9A-Fa-f]{1,6}$/
const SAFE_EXTERNAL = /^(https?:|mailto:)/i
// Символ, которым заменяется непонятный код: □.
const PLACEHOLDER_CHAR = '25A1'

export const SAFE_DOCX_OPTIONS = { renderAltChunks: false }

// Обходит всю модель документа (части, связи, элементы). Пакет архива и узлы XML не обходятся.
export function sanitizeDocxModel(root, { maxNodes = 2_000_000 } = {}) {
  const seen = new Set()
  const stack = [root]
  let count = 0
  while (stack.length) {
    const value = stack.pop()
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    if (++count > maxNodes) throw new Error('Документ слишком сложный для просмотра')
    if (typeof Node !== 'undefined' && value instanceof Node) continue
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) continue
    if (value.type === 'symbol' && !HEX_CHAR.test(String(value.char ?? ''))) value.char = PLACEHOLDER_CHAR
    if (value.targetMode === 'External' && typeof value.target === 'string' && !SAFE_EXTERNAL.test(value.target.trim())) {
      value.target = ''
    }
    for (const key of Object.keys(value)) {
      if (key.startsWith('_')) continue
      const child = value[key]
      if (child && typeof child === 'object') stack.push(child)
    }
  }
  return root
}
