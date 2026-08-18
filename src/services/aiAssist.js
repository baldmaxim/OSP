// Frontend-сервис ИИ-помощника (Edge Function `ai-assist`).
// Ключ Anthropic живёт только в функции; фронт отправляет содержимое пункта.
import { supabase } from '../supabase'

const FUNCTION_NAME = 'ai-assist'

export const AI_MODES = [
  { value: 'compromise', label: 'Компромиссная редакция', hint: 'Формулировка, закрывающая возражение подрядчика' },
  { value: 'reply', label: 'Ответ подрядчику', hint: 'Позиция + текст для обсуждения' },
  { value: 'risks', label: 'Риски редакции', hint: 'Чем грозит формулировка подрядчика' },
]

// Предложение по пункту протокола. Бросает Error с человекочитаемым текстом.
export async function suggestClause({
  mode = 'compromise',
  clauseLabel,
  ourText,
  counterpartyText,
  finalText,
  counterpartyName,
  contract,
  comments = [],
}) {
  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
    body: {
      action: 'clause_suggest',
      mode,
      clause_label: clauseLabel,
      our_text: ourText,
      counterparty_text: counterpartyText,
      final_text: finalText,
      counterparty_name: counterpartyName,
      contract,
      // В модель уходит только переписка по этому пункту, без лишних персональных данных.
      comments: comments.map((c) => ({ side: c.author_side, name: c.author_name, body: c.body })),
    },
  })

  if (error) {
    // supabase-js прячет реальную причину за «non-2xx status code» — достаём тело ответа.
    let detail = ''
    try {
      const ctx = error.context
      if (ctx && typeof ctx.clone === 'function') {
        const body = await ctx.clone().json().catch(() => null)
        detail = body?.error || ''
      }
    } catch { /* тело недоступно или не JSON */ }
    throw new Error(detail || error.message || 'Не удалось получить ответ ИИ')
  }
  if (data?.error) throw new Error(data.error)
  if (!data?.text) throw new Error('Пустой ответ ИИ')
  return data
}
