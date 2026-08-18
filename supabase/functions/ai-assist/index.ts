// Edge Function `ai-assist` — ИИ-помощник по протоколу разногласий.
//
// Назначение: по конкретному пункту договора предложить формулировку —
// компромиссную редакцию, ответ подрядчику или разбор рисков. Ключ Anthropic
// живёт только здесь; в браузер он не попадает.
//
// Операции (POST { action, ... }):
//   action=clause_suggest {
//     mode: 'compromise' | 'reply' | 'risks',
//     clause_label, our_text, counterparty_text, final_text,
//     counterparty_name, contract: { number, date, object, work },
//     comments: [{ side: 'employee'|'contractor', name, body }]
//   } → { text, model, usage }
//
// Авторизация: требует Authorization: Bearer <supabase_jwt> (как в s3-presign).
//
// Секрет в окружении функции:
//   ANTHROPIC_API_KEY — ключ Claude API (console.anthropic.com).
import Anthropic from 'npm:@anthropic-ai/sdk@0.68.0'
import { createClient } from 'jsr:@supabase/supabase-js@2'

const MODEL = 'claude-opus-5'
// Юридическая формулировка — задача не длинная: обычного (нестримингового)
// запроса достаточно, 16k с запасом покрывает ответ.
const MAX_TOKENS = 16000

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey, x-supabase-api-version',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

const SYSTEM_PROMPT = `Ты — юрист строительной компании СУ-10 (Казахстан), ведёшь протокол разногласий по договору подряда.
Тебе дают один пункт договора: исходную редакцию заказчика (СУ-10), редакцию подрядчика и переписку сторон по этому пункту.

Правила работы:
- Отвечай по-русски, в деловом стиле договора, без воды и без обращений.
- Работай только с этим пунктом: не переписывай остальной договор и не выдумывай условия, которых нет во входных данных.
- Если данных не хватает для вывода (нет редакции подрядчика, не ясен предмет), прямо скажи, чего не хватает, вместо догадок.
- Формулировки давай готовыми к вставке в договор: полным текстом пункта, с его номером, без markdown-разметки и комментариев внутри текста пункта.
- Ты помогаешь юристу подготовить позицию — окончательное решение принимает человек.`

const MODE_PROMPT: Record<string, string> = {
  compromise:
    'Предложи компромиссную редакцию пункта, которая закрывает возражение подрядчика, но сохраняет защиту интересов СУ-10.\n' +
    'Формат ответа:\n' +
    'ПРЕДЛАГАЕМАЯ РЕДАКЦИЯ:\n<полный текст пункта>\n\nЧТО ИЗМЕНИЛОСЬ И ПОЧЕМУ:\n<3–5 коротких пунктов>',
  reply:
    'Подготовь ответ подрядчику по этому пункту: принять, отклонить или принять с оговоркой — с обоснованием.\n' +
    'Формат ответа:\n' +
    'ПОЗИЦИЯ: <принимаем / отклоняем / принимаем с оговоркой>\n\nОТВЕТ ПОДРЯДЧИКУ:\n<текст, который можно отправить в обсуждение>',
  risks:
    'Разбери риски редакции подрядчика для СУ-10.\n' +
    'Формат ответа:\n' +
    'РИСКИ:\n<список: риск — чем грозит — насколько существенно>\n\nЧТО ПОПРАВИТЬ:\n<короткий список правок к формулировке>',
}

function buildUserPrompt(b: Record<string, unknown>): string {
  const contract = (b.contract || {}) as Record<string, string>
  const comments = Array.isArray(b.comments) ? b.comments : []
  const cpName = String(b.counterparty_name || 'Подрядчик')

  const lines: string[] = []
  lines.push('ДОГОВОР')
  lines.push(`Номер: ${contract.number || '—'}`)
  lines.push(`Дата: ${contract.date || '—'}`)
  lines.push(`Объект: ${contract.object || '—'}`)
  lines.push(`Работы: ${contract.work || '—'}`)
  lines.push(`Подрядчик: ${cpName}`)
  lines.push('')
  lines.push(`ПУНКТ: ${b.clause_label || '—'}`)
  lines.push('')
  lines.push('ИСХОДНАЯ РЕДАКЦИЯ (СУ-10):')
  lines.push(String(b.our_text || '— (не указана)'))
  lines.push('')
  lines.push(`РЕДАКЦИЯ ${cpName.toUpperCase()}:`)
  lines.push(String(b.counterparty_text || '— (подрядчик пока не предложил свою редакцию)'))
  if (b.final_text) {
    lines.push('')
    lines.push('ТЕКУЩАЯ ИТОГОВАЯ РЕДАКЦИЯ:')
    lines.push(String(b.final_text))
  }
  if (comments.length > 0) {
    lines.push('')
    lines.push('ОБСУЖДЕНИЕ ПО ПУНКТУ:')
    for (const c of comments as Array<Record<string, string>>) {
      const who = c.side === 'employee' ? `СУ-10, ${c.name || 'сотрудник'}` : `${cpName}, ${c.name || 'представитель'}`
      lines.push(`— ${who}: ${c.body || ''}`)
    }
  }
  lines.push('')
  lines.push('ЗАДАЧА:')
  lines.push(MODE_PROMPT[String(b.mode || 'compromise')] || MODE_PROMPT.compromise)
  return lines.join('\n')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  // 1) Авторизация Supabase JWT.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return jsonResponse({ error: 'Unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse({ error: 'Supabase env not configured' }, 500)
  }
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return jsonResponse({ error: 'Unauthorized' }, 401)

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return jsonResponse({ error: 'ANTHROPIC_API_KEY не задан в секретах функции' }, 500)

  // 2) Тело запроса.
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400)
  }
  if (body.action !== 'clause_suggest') {
    return jsonResponse({ error: `Unknown action: ${body.action}` }, 400)
  }
  if (!body.our_text && !body.counterparty_text) {
    return jsonResponse({ error: 'Нет текста пункта — нечего анализировать.' }, 400)
  }

  // 3) Запрос в Claude.
  try {
    const client = new Anthropic({ apiKey })
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Задача требует рассуждения (сопоставить две редакции и переписку),
      // но не исследовательская — medium даёт нужное качество без лишних токенов.
      output_config: { effort: 'medium' },
      // Классификаторы Claude Opus 5 могут отклонить запрос; server-side fallback
      // сам переигрывает его на резервной модели вместо отказа пользователю.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(body) }],
    })

    if (response.stop_reason === 'refusal') {
      return jsonResponse({ error: 'Модель отклонила запрос по этому пункту. Попробуйте переформулировать или обратитесь к юристу.' }, 422)
    }

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
      .trim()

    if (!text) return jsonResponse({ error: 'Модель вернула пустой ответ. Попробуйте ещё раз.' }, 502)

    return jsonResponse({
      text,
      model: response.model,
      usage: {
        input_tokens: response.usage?.input_tokens ?? null,
        output_tokens: response.usage?.output_tokens ?? null,
      },
    })
  } catch (e) {
    console.error('ai-assist error:', e)
    return jsonResponse({ error: (e as Error)?.message || 'Ошибка обращения к ИИ' }, 500)
  }
})
