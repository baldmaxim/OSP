// Пословное сравнение двух текстов (LCS по токенам).
// Изначально жило в TendersPage (история правок примечания участника),
// вынесено сюда для протокола разногласий (колонка «Изменения»).

// Токены — слова и пробельные промежутки. Промежутки приводим к одному виду
// (' ' или '\n'), иначе лишний пробел подсвечивается как правка.
export function tokenizeWords(text) {
  const raw = String(text || '').match(/\s+|\S+/g) || []
  return raw.map(t => (/^\s+$/.test(t) ? (t.includes('\n') ? '\n' : ' ') : t))
}

// Ограничение на размер: защищаемся от квадратичной таблицы на аномально
// длинном тексте — там показываем блоки целиком.
export const DIFF_MAX_TOKENS = 800

// Возвращает массив { type: 'same' | 'added' | 'removed', text }.
export function diffWords(oldText, newText) {
  const a = tokenizeWords(oldText)
  const b = tokenizeWords(newText)
  if (a.length > DIFF_MAX_TOKENS || b.length > DIFF_MAX_TOKENS) {
    const out = []
    if (a.length) out.push({ type: 'removed', text: String(oldText || '') })
    if (b.length) out.push({ type: 'added', text: String(newText || '') })
    return out
  }
  const n = a.length
  const m = b.length
  const w = m + 1
  // lcs[i][j] — длина наибольшей общей подпоследовательности a[i..] и b[j..]
  const lcs = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j]
        ? lcs[(i + 1) * w + j + 1] + 1
        : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }
  const parts = []
  const push = (type, text) => {
    const last = parts[parts.length - 1]
    if (last && last.type === type) last.text += text
    else parts.push({ type, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++ }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) { push('removed', a[i]); i++ }
    else { push('added', b[j]); j++ }
  }
  while (i < n) { push('removed', a[i]); i++ }
  while (j < m) { push('added', b[j]); j++ }
  return parts
}

// Счётчик изменений в словах (пробельные токены не считаем) — для подписи «+N / −M».
export function countDiffWords(parts) {
  let added = 0
  let removed = 0
  for (const p of parts) {
    const words = String(p.text || '').match(/\S+/g)?.length || 0
    if (p.type === 'added') added += words
    else if (p.type === 'removed') removed += words
  }
  return { added, removed }
}
