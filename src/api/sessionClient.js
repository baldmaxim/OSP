// Связка своего входа с браузером: fetch с отметкой защиты (session.js) для всех запросов к своему серверу и
// единственный экземпляр своего входа (ownAuth.js). Отказ «вход изменился» (сервер переключили, а вкладка
// старая) — перезагрузка, не чаще раза в минуту: вкладка получит новую сборку и форму входа.
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
    else own?.sessionEvent(code)
  },
})

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('osp-auth') : null
own = createOwnAuth({ fetchImpl: sessionFetch, channel })
export const ownAuth = own
