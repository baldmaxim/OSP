// Сравнить наименования глазами: позиция ВОР и строка счёта стоят рядом, а слова и числа, которых нет у другой стороны, подсвечены
// (то же сравнение, что у похожести: основа слова, сокращение, размер в любом порядке). Служебные слова не подсвечиваются.
import { expandName } from './supplyDocMatch.js'
import { nameParts, sameWord } from './supplySimilarity.js'

// Ответ: [{ text, differs }] — куски наименования подряд, вместе с пробелами и знаками.
export function nameDiff(name, other) {
  const them = nameParts(expandName(other))
  const differs = (piece) => {
    const p = nameParts(expandName(piece))
    return p.nums.some((n) => !them.nums.includes(n)) || p.words.some((w) => !them.words.some((x) => sameWord(w, x)))
  }
  const out = []
  // Запятая между цифрами — часть числа: «12,7» — одно значение.
  for (const part of String(name ?? '').split(/((?:[^\s,;()]|(?<=[0-9]),(?=[0-9]))+)/)) {
    if (!part) continue
    const d = /[^\s,;()]/.test(part) && differs(part)
    const last = out[out.length - 1]
    if (last && last.differs === d) last.text += part
    else out.push({ text: part, differs: d })
  }
  return out
}
