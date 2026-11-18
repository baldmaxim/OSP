// Общий шаблон письма подрядчикам «Тендеров — Основное строительство» (18.11.2026).
// До этого шаблон жил только в браузере (localStorage) — у каждого свой; теперь администратор сохраняет один
// на всех в app_settings. Ключ не подходит ни под один раздел в app_settings_key_sections базы, поэтому
// писать его может только администратор (миграция не нужна). Нет строки или значение пустое — общий шаблон
// ещё не задан: письмо, как раньше, берёт текст из браузера, иначе — шаблон по умолчанию.
export const SHARED_LETTER_TEMPLATE_KEY = 'tender_letter_template:construction'

export const LETTER_TEMPLATE_MAX = 20000

// Значение app_settings → текст шаблона или null (общего шаблона нет).
export function parseSharedLetterTemplate(value) {
  const text = typeof value === 'string' ? value : ''
  return text.trim() ? text : null
}

// Текст из поля → { value } (пробелы в конце убраны) или { error }.
export function checkLetterTemplate(raw) {
  const value = String(raw ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  if (!value.trim()) return { error: 'Шаблон пустой. Впишите текст письма или верните шаблон по умолчанию.' }
  if (value.length > LETTER_TEMPLATE_MAX) {
    return { error: `Шаблон слишком длинный: ${value.length} знаков, можно не больше ${LETTER_TEMPLATE_MAX}.` }
  }
  return { value }
}

// Кто и что видит во вкладке «Шаблон письма».
//   shared — общий шаблон включён для этой страницы (ОС); sharedText — текст из базы или null;
//   localText — шаблон из браузера (или по умолчанию).
// → text — что показываем и чем формируем письмо;
//   mode: 'shared-admin' — администратор правит общий (сохранение — в базу);
//         'shared-view'  — общий задан, остальным только чтение;
//         'local'        — как раньше: свой шаблон в браузере (правит обладатель права правки «Тендеров»).
export function letterTemplateView({ shared, sharedText, localText, isAdmin }) {
  if (!shared) return { mode: 'local', text: localText }
  const text = sharedText || localText
  if (isAdmin) return { mode: 'shared-admin', text }
  return { mode: sharedText ? 'shared-view' : 'local', text }
}
