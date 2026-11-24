// «Signal» — сверка договоров с папками SIGNAL: клиент своего сервера (server/osp-api/src/routes/signal.js, маршруты /api/signal/*).
// В SIGNAL браузер не ходит и ничего туда не пишет: сервер читает снимок папок, браузер получает только метки, состояния и
// решения человека (подтвердить, заменить, отклонить, отвязать). Права и охват проверяет сервер — здесь только удобство.
//
// Ответ — данные или исключение SignalApiError { status, code, message }: message — русский текст сервера, status 0 —
// сети нет (code 'network') или не дождались ответа (code 'timeout'). 409 stale_state — окно устарело (ссылку или состояние
// успел изменить другой): isStale. Исключение — status(): интеграция выключена, сервер без неё, сбой — всегда
// { enabled: false }: портал работает как раньше. Модуль чистый: fetch передаётся извне (src/api/signal.js даёт сессионный).
export class SignalApiError extends Error {
  constructor(status, body, fallback) {
    super(body?.error || fallback || (status ? `Сервер ответил ${status}` : 'Сервер недоступен'))
    this.name = 'SignalApiError'
    this.status = status
    this.code = body?.code || null
  }

  // Окно устарело: ссылку или состояние договора успел изменить другой (409 stale_state; без кода — то же).
  get isStale() {
    return this.status === 409 && (!this.code || this.code === 'stale_state')
  }
}

export const SIGNAL_DISABLED = Object.freeze({ enabled: false, canView: false, canEdit: false, isAdmin: false })
const MATCH_CHUNK = 200
const MARKS_PAGE = 500
const MARKS_MAX_PAGES = 400

// Ключ идемпотентности: один на открытие окна действия. randomUUID есть только в защищённом контексте — запасной ход
// собирает uuid v4 из getRandomValues.
export function newIdempotencyKey() {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  const b = new Uint8Array(16)
  if (c?.getRandomValues) c.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const query = (params) => {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  return pairs.length ? `?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}` : ''
}

export function createSignalClient({ fetchImpl, newKey = newIdempotencyKey }) {
  // timeoutMs — сколько ждать ответ целиком (запрос и тело); 0 — без предела.
  async function call(path, { method = 'GET', body, timeoutMs = 0 } = {}) {
    const controller = timeoutMs > 0 && typeof AbortController === 'function' ? new AbortController() : null
    let timedOut = false
    const timer = controller ? setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs) : null
    let res
    let data = null
    try {
      res = await fetchImpl(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
      })
      try { data = await res.json() } catch { /* пусто или не JSON */ }
    } catch {
      throw timedOut
        ? new SignalApiError(0, { code: 'timeout' }, 'Сверка Signal не ответила вовремя')
        : new SignalApiError(0, { code: 'network' })
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (!res.ok) throw new SignalApiError(res.status, data)
    return data || {}
  }

  const contractPath = (id, tail = '') => `/api/signal/contracts/${encodeURIComponent(id)}${tail}`
  const marks = ({ after, limit } = {}) => call(`/api/signal/marks${query({ after, limit })}`)

  return {
    newKey,

    // { enabled, dataAt, generation, canView, canEdit, isAdmin, confirmAvailable, fileLinks, … }. Выключено, нет маршрута,
    // 401/403/404/503, сеть, не JSON (стенд или старый сервер отдаёт страницу) — { enabled: false }.
    async status() {
      try {
        const data = await call('/api/signal/status', { timeoutMs: 8000 })
        return data.enabled === true ? { ...SIGNAL_DISABLED, ...data, enabled: true } : SIGNAL_DISABLED
      } catch {
        return SIGNAL_DISABLED
      }
    },

    // Страница меток: { items: [{ id, state, reason, pending, tip, hasCandidate }], next, dataAt }.
    marks,

    // Все метки охвата — цикл по курсору. Map id → метка; Map.dataAt — на какое время данные Signal.
    async allMarks({ limit = MARKS_PAGE } = {}) {
      const map = new Map()
      let after
      let dataAt = null
      for (let i = 0; i < MARKS_MAX_PAGES; i++) {
        const page = await marks({ after, limit })
        for (const m of page.items || []) if (m && m.id) map.set(m.id, m)
        dataAt = page.dataAt ?? dataAt
        if (!page.next || page.next === after) break
        after = page.next
      }
      map.dataAt = dataAt
      return map
    },

    // Данные окна сверки: состояние, версия, ссылка, узел, файлы, кандидаты (при правке).
    contract: (id, { nodeId } = {}) => call(contractPath(id, query({ nodeId }))),

    // Поиск папки объекта договора для «Другая папка…».
    folders: (contractId, { q, after, limit } = {}) => call(`/api/signal/folders${query({ contractId, q, after, limit })}`),

    // Сверка по опубликованному снимку (в SIGNAL не ходит, ссылку не меняет): порции по 200 уникальных id; timeoutMs — на
    // порцию. Не бросает: порция без ответа даёт failed (её id), error — первая ошибка. items — по одному на id.
    async match(ids, { timeoutMs = 0 } = {}) {
      const unique = [...new Set((ids || []).filter(Boolean))]
      const byId = new Map()
      const failed = []
      let dataAt = null
      let error = null
      for (let i = 0; i < unique.length; i += MATCH_CHUNK) {
        const chunk = unique.slice(i, i + MATCH_CHUNK)
        const asked = new Set(chunk)
        try {
          const res = await call('/api/signal/match', { method: 'POST', body: { contractIds: chunk }, timeoutMs })
          dataAt = res.dataAt ?? dataAt
          for (const it of res.items || []) if (it && asked.has(it.id)) byId.set(it.id, it)
        } catch (e) {
          failed.push(...chunk)
          error = error || e
        }
      }
      return { dataAt, items: [...byId.values()], failed, error }
    },

    confirm: (id, body) => call(contractPath(id, '/confirm'), { method: 'POST', body }),
    reject: (id, body) => call(contractPath(id, '/reject'), { method: 'POST', body }),
    unlink: (id, body) => call(contractPath(id, '/unlink'), { method: 'POST', body }),

    aliases: {
      list: () => call('/api/signal/aliases'),
      create: (objectId, text) => call('/api/signal/aliases', { method: 'POST', body: { objectId, text } }),
      // Сервер (authenticate в app.js) ждёт у DELETE тело-объект, как у su10OrgsClient.
      remove: (id) => call(`/api/signal/aliases/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} }),
    },

    // «Администрирование» → «Signal» (только администратор; ответ сервера на чужую учётку — 403).
    admin: {
      addSource: (url, objectIds = []) => call('/api/signal/sources', { method: 'POST', body: { url, objectIds } }),
      updateSource: (id, patch) => call(`/api/signal/sources/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
      sync: () => call('/api/signal/sync', { method: 'POST', body: {} }),
      runs: ({ limit } = {}) => call(`/api/signal/runs${query({ limit })}`),
      unassigned: ({ sourceId, after, limit } = {}) => call(`/api/signal/unassigned${query({ sourceId, after, limit })}`),
      bind: ({ sourceId, nodeId, objectId = null }) => call('/api/signal/bindings', { method: 'POST', body: { sourceId, nodeId, objectId } }),
    },
  }
}
