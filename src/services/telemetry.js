/* global __BUILD_ID__ */
// Телеметрия для безопасных релизов (миграция 20261007_client_telemetry.sql):
//   • какая сборка открыта у пользователя — чтобы убирать старое на сервере,
//     только когда старых вкладок не осталось;
//   • коды отказов сервера по разделам — чтобы после выкладки сразу видеть,
//     если кого-то заблокировало.
//
// Мягко: пока миграция не применена (функций в базе нет), первый же ответ
// «функция не найдена» выключает отправку до перезагрузки — без ошибок на экране
// и без повторных запросов. Только для вошедших пользователей; без персональных
// данных (см. supabase/clientErrors.js).
import { supabase } from '../supabase'
import { onClientError } from '../supabase/clientErrors'

const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'
const VERSION_INTERVAL_MS = 10 * 60 * 1000
const ERROR_REPEAT_MS = 60 * 1000
const MAX_ERRORS_PER_MINUTE = 20

const disabled = { version: false, error: false }
let lastVersionAt = 0
const lastErrorAt = new Map()
let minuteStart = 0
let sentThisMinute = 0

// Функции ещё нет в базе (миграция не применена) — больше не пытаемся.
function isMissingFunction(error, status) {
  return error?.code === 'PGRST202' || error?.code === '42883' || status === 404
}

async function hasSession() {
  try {
    const { data } = await supabase.auth.getSession()
    return !!data?.session
  } catch {
    return false
  }
}

export async function reportClientVersion() {
  if (disabled.version || BUILD_ID === 'dev') return
  const now = Date.now()
  if (now - lastVersionAt < VERSION_INTERVAL_MS) return
  lastVersionAt = now
  if (!(await hasSession())) return
  const { error, status } = await supabase.rpc('report_client_version', { p_build_id: BUILD_ID })
  if (error && isMissingFunction(error, status)) disabled.version = true
}

async function reportClientError({ section, code, status }) {
  if (disabled.error || BUILD_ID === 'dev') return
  const now = Date.now()
  const key = `${section}|${code}`
  if (now - (lastErrorAt.get(key) || 0) < ERROR_REPEAT_MS) return
  if (now - minuteStart > 60 * 1000) { minuteStart = now; sentThisMinute = 0 }
  if (sentThisMinute >= MAX_ERRORS_PER_MINUTE) return
  lastErrorAt.set(key, now)
  sentThisMinute += 1
  if (!(await hasSession())) return
  const res = await supabase.rpc('report_client_error', {
    p_build_id: BUILD_ID, p_section: section, p_code: code, p_status: status,
  })
  if (res.error && isMissingFunction(res.error, res.status)) disabled.error = true
}

onClientError((event) => {
  reportClientError(event).catch(() => { /* телеметрия не должна мешать работе */ })
})
