// POST /api/fn/ai-assist — перенос Edge Function `ai-assist` (supabase/functions/ai-assist):
// тот же запрос, ответ, модель и подсказки. Ключ Anthropic только здесь, в браузер не попадает.
//
//   action=clause_suggest { mode, clause_label, our_text, counterparty_text, final_text,
//                           counterparty_name, contract, comments } → { text, model, usage }
//
// Отличие от функции — доступ: функция пускала любого вошедшего (inventory § 1), здесь только
// одобренного сотрудника, как и в интерфейсе (кнопка «ИИ» видна только сотруднику).
export const MODEL = 'claude-opus-5'
// Юридическая формулировка — задача не длинная: обычного запроса достаточно, 16k с запасом.
export const MAX_TOKENS = 16000

export const SYSTEM_PROMPT = `Ты — юрист строительной компании СУ-10 (Казахстан), ведёшь протокол разногласий по договору подряда.
Тебе дают один пункт договора: исходную редакцию заказчика (СУ-10), редакцию подрядчика и переписку сторон по этому пункту.

Правила работы:
- Отвечай по-русски, в деловом стиле договора, без воды и без обращений.
- Работай только с этим пунктом: не переписывай остальной договор и не выдумывай условия, которых нет во входных данных.
- Если данных не хватает для вывода (нет редакции подрядчика, не ясен предмет), прямо скажи, чего не хватает, вместо догадок.
- Формулировки давай готовыми к вставке в договор: полным текстом пункта, с его номером, без markdown-разметки и комментариев внутри текста пункта.
- Ты помогаешь юристу подготовить позицию — окончательное решение принимает человек.`

const MODE_PROMPT = {
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

export function buildUserPrompt(b) {
  const contract = (b.contract && typeof b.contract === 'object') ? b.contract : {}
  const comments = Array.isArray(b.comments) ? b.comments : []
  const cpName = String(b.counterparty_name || 'Подрядчик')

  const lines = []
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
    for (const c of comments) {
      const who = c?.side === 'employee' ? `СУ-10, ${c?.name || 'сотрудник'}` : `${cpName}, ${c?.name || 'представитель'}`
      lines.push(`— ${who}: ${c?.body || ''}`)
    }
  }
  lines.push('')
  lines.push('ЗАДАЧА:')
  lines.push(Object.hasOwn(MODE_PROMPT, String(b.mode || '')) ? MODE_PROMPT[String(b.mode)] : MODE_PROMPT.compromise)
  return lines.join('\n')
}

// Сотрудник — одобрен, без организации-контрагента и не с ролью подрядчика (правило
// osp_is_employee из миграции 20261010). Администратор одобрен и без организации.
export function isEmployeeRole(row) {
  return !!row && row.is_approved === true && !row.counterparty_id && row.role !== 'contractor'
}

export function registerAiAssist(app, { config, authenticate, getAnthropic, limiters }) {
  app.post('/api/fn/ai-assist', async (request, reply) => {
    const auth = await authenticate(request, reply)
    if (!auth) return reply
    const { supabase, user } = auth

    const { data: roleRow } = await supabase
      .from('user_roles')
      .select('role, counterparty_id, is_approved')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!isEmployeeRole(roleRow)) {
      return reply.code(403).send({ error: 'ИИ-помощник доступен только сотрудникам' })
    }

    if (!config.anthropicApiKey) {
      return reply.code(500).send({ error: 'ANTHROPIC_API_KEY не задан в секретах функции' })
    }

    const body = request.body
    if (body.action !== 'clause_suggest') {
      return reply.code(400).send({ error: `Unknown action: ${body.action}` })
    }
    if (!body.our_text && !body.counterparty_text) {
      return reply.code(400).send({ error: 'Нет текста пункта — нечего анализировать.' })
    }

    // Платный ИИ: не чаще limits.aiPerUser, один ответ за раз на пользователя, всего — aiConcurrentTotal.
    const releaseUser = limiters.aiUser.acquire(user.id)
    if (!releaseUser) return reply.code(429).send({ error: 'ИИ уже готовит ответ — дождитесь его' })
    const releaseTotal = limiters.aiTotal.acquire('all')
    if (!releaseTotal) {
      releaseUser()
      return reply.code(429).send({ error: 'ИИ сейчас занят — попробуйте через минуту' })
    }
    if (!limiters.aiRate.take(user.id)) {
      releaseUser()
      releaseTotal()
      return reply.code(429).send({ error: 'Слишком много запросов к ИИ — подождите минуту' })
    }

    try {
      const client = getAnthropic()
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // Нужно рассуждение (сопоставить две редакции и переписку), но не исследование.
        output_config: { effort: 'medium' },
        // Если классификатор отклонит запрос, сервер сам переиграет его на резервной модели.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(body) }],
      })

      if (response.stop_reason === 'refusal') {
        return reply.code(422).send({ error: 'Модель отклонила запрос по этому пункту. Попробуйте переформулировать или обратитесь к юристу.' })
      }

      const text = (response.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (!text) return reply.code(502).send({ error: 'Модель вернула пустой ответ. Попробуйте ещё раз.' })

      return {
        text,
        model: response.model,
        usage: {
          input_tokens: response.usage?.input_tokens ?? null,
          output_tokens: response.usage?.output_tokens ?? null,
        },
      }
    } catch (e) {
      request.log.error({ msg: e?.message }, 'ai-assist')
      return reply.code(500).send({ error: e?.message || 'Ошибка обращения к ИИ' })
    } finally {
      releaseUser()
      releaseTotal()
    }
  })
}
