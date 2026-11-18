// Общий шаблон письма подрядчикам (ОС) — строка app_settings; правила — utils/tenderLetterTemplate.js.
import { db } from '../api'
import { SHARED_LETTER_TEMPLATE_KEY, parseSharedLetterTemplate } from '../utils/tenderLetterTemplate'

// → { text, updatedAt }; text = null — общий шаблон не задан.
export async function fetchSharedLetterTemplate() {
  const { data, error } = await db
    .from('app_settings')
    .select('value, updated_at')
    .eq('key', SHARED_LETTER_TEMPLATE_KEY)
    .maybeSingle()
  if (error) throw error
  const text = parseSharedLetterTemplate(data?.value)
  return { text, updatedAt: text ? data?.updated_at || null : null }
}

// Пишет администратор: в базе нового портала это проверяет триггер app_settings_write_guard (42501).
export async function saveSharedLetterTemplate(text) {
  const updatedAt = new Date().toISOString()
  const { error } = await db
    .from('app_settings')
    .upsert({ key: SHARED_LETTER_TEMPLATE_KEY, value: text, updated_at: updatedAt }, { onConflict: 'key' })
  if (error) throw error
  return { text, updatedAt }
}
