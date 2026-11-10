// Связка своего входа с браузером: fetch с отметкой защиты (session.js) для всех запросов к своему серверу и
// единственный экземпляр своего входа (ownAuth.js). Отказ «вход изменился» (сервер переключили, а вкладка
// старая) — перезагрузка, не чаще раза в минуту: вкладка получит новую сборку и форму входа.
// Вход через СУ-10: действия пользователя (клик, клавиша, возврат на вкладку, загрузка страницы) отмечаются заголовком
// X-OSP-Activity; простаивающая вкладка (OSP_IDLE) не ходит на сервер до первого действия; доступ к порталу отозван в
// СУ-10 (OSP_NO_PORTAL_ACCESS) — страница «Нет доступа».
import { observingFetch } from './clientErrors'
import { createSessionFetch } from './session'
import { createOwnAuth } from './ownAuth'

const RELOAD_KEY = 'osp.authModeReloadAt'
let own = null

function reloadOnce() {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) || 0)
    if (Date.now() - last < 60_000) return
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch { /* без хранилища — просто перезагружаем */ }
  window.location.reload()
}

export const sessionFetch = createSessionFetch({
  fetchImpl: observingFetch,
  origin: window.location.origin,
  getCookies: () => document.cookie,
  onEvent: (code) => {
    if (code === 'OSP_AUTH_MODE') reloadOnce()
    else if (code === 'OSP_NO_PORTAL_ACCESS') {
      if (window.location.pathname !== '/no-access') window.location.assign('/no-access')
    } else if (code !== 'OSP_IDLE') own?.sessionEvent(code)
  },
})

// Действие пользователя: следующие 10 с запросы к своему серверу — с отметкой действия. Вкладка простаивала — сразу короткий
// запрос с действием (сессия продлевается, опрос продолжается сам).
function activity() {
  if (sessionFetch.markActivity()) sessionFetch('/api/auth/me', { cache: 'no-store' }).catch(() => {})
}
if (typeof window.addEventListener === 'function') {
  activity() // загрузка страницы — тоже действие
  for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, activity, { capture: true, passive: true })
  document.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'visible') activity() })
}

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('osp-auth') : null
own = createOwnAuth({ fetchImpl: sessionFetch, channel })
// Вошли в соседнем окне (повторный вход через СУ-10): это действие — пауза простоя снимается, «кто я» идёт в сеть.
own.onAuthStateChange((event) => { if (event === 'SIGNED_IN_ELSEWHERE') sessionFetch.markActivity() })
export const ownAuth = own
