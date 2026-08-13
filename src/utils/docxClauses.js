// Разбор .docx на пункты договора в браузере (без новых зависимостей — pizzip уже
// в проекте как peer docxtemplater). Извлекаем абзацы из word/document.xml и делим
// на пункты по нумерации (1., 1.1., 1.1.2 …). Эвристика намеренно простая и
// предсказуемая — «опасное угадывание» не используем; спорное правится вручную.
import PizZip from 'pizzip'

// Разэкранирование XML-сущностей.
function decodeXml(s) {
  return s
    .replace(/<w:tab\/>/g, ' ')
    .replace(/<w:br\/>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
}

// Текст одного абзаца <w:p>…</w:p> — склейка всех <w:t>…</w:t>.
function paragraphText(pXml) {
  const runs = pXml.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) || []
  const text = runs
    .map((r) => r.replace(/<w:t[^>]*>/, '').replace(/<\/w:t>/, ''))
    .join('')
  return decodeXml(text).replace(/\s+/g, ' ').trim()
}

// Извлечь абзацы (только текст) из .docx.
export function extractParagraphs(arrayBuffer) {
  const zip = new PizZip(arrayBuffer)
  const file = zip.file('word/document.xml')
  if (!file) throw new Error('Не найден word/document.xml — это не .docx?')
  const xml = file.asText()
  const paras = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []
  return paras.map(paragraphText).filter((t) => t.length > 0)
}

// Ведущая нумерация пункта: «1», «1.1», «1.1.2», «1)» и т.п. → { number, level, rest }.
function parseNumbering(text) {
  // 1.  /  1.1.  /  1.1.2)  /  1)
  const m = text.match(/^(\d+(?:\.\d+)*)[.)]?\s+(.*)$/)
  if (!m) return null
  const number = m[1]
  const level = number.split('.').length
  return { number, level, rest: m[2] }
}

// Похоже на заголовок раздела: без нумерации, короткий, преимущественно верхний регистр.
function looksLikeHeading(text) {
  if (text.length > 80) return false
  const letters = text.replace(/[^A-Za-zА-Яа-яЁё]/g, '')
  if (letters.length < 3) return false
  const upper = text.replace(/[^A-ZА-ЯЁ]/g, '').length
  return upper / letters.length > 0.6
}

// Основной разбор: массив абзацев → массив пунктов.
// { clause_number, body, level, is_heading, order_index }
export function paragraphsToClauses(paragraphs) {
  const clauses = []
  let order = 0
  for (const para of paragraphs) {
    const num = parseNumbering(para)
    if (num) {
      clauses.push({
        clause_number: num.number,
        body: num.rest,
        level: num.level,
        is_heading: false,
        order_index: order++,
      })
    } else if (looksLikeHeading(para) && (clauses.length === 0 || !clauses[clauses.length - 1].is_heading)) {
      clauses.push({
        clause_number: '',
        body: para,
        level: 1,
        is_heading: true,
        order_index: order++,
      })
    } else if (clauses.length > 0) {
      // Продолжение предыдущего пункта (перенос строки внутри пункта).
      const prev = clauses[clauses.length - 1]
      prev.body = (prev.body ? prev.body + '\n' : '') + para
    } else {
      // Текст до первого пункта (преамбула) — отдельный ненумерованный пункт.
      clauses.push({ clause_number: '', body: para, level: 1, is_heading: false, order_index: order++ })
    }
  }
  return clauses
}

// Удобная обёртка: arrayBuffer → пункты.
export function parseDocxClauses(arrayBuffer) {
  return paragraphsToClauses(extractParagraphs(arrayBuffer))
}
