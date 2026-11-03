// Утверждённый список маршрутов, доступных без входа пользователя, — с обоснованием.
// Открытый маршрут не из этого списка сервер зарегистрировать откажется (src/lib/access.js), а тест
// tests/osp-api/access.test.mjs сверяет список со снимком в репозитории: новый открытый адрес — это
// решение, а не правка. Меняется вместе со снимком tests/osp-api/baseline/routes.json.
import { GATEWAY_METHODS, GATEWAY_URL, GATEWAY_REASON } from './routes/dbGateway.js'
import { COVERS_OPEN_REASON, COVER_THUMBS_OPEN_REASON } from './routes/covers.js'
import { AUTH_CONFIG_REASON, AUTH_LOGIN_REASON, AUTH_LOGOUT_REASON } from './routes/auth.js'
import { SIGNUP_CHALLENGE_REASON, SIGNUP_REGISTER_REASON, SIGNUP_PREVIEW_REASON, SIGNUP_CONFIRM_REASON, SIGNUP_CLAIM_REASON, PASSWORD_FORGOT_REASON, PASSWORD_RESET_REASON } from './routes/signup.js'

export const OPEN_ROUTES = [
  {
    method: 'GET', url: '/api/health', kind: 'open',
    reason: 'Проверка «служба жива» для выкладки и мониторинга: отдаёт только признаки настройки, без данных',
  },
  {
    method: 'GET', url: '/api/ready', kind: 'open',
    reason: 'Проверка зависимостей при выкладке: отвечает только запросам с самого сервера, через nginx — 404',
  },
  {
    method: 'GET', url: '/api/rates', kind: 'apiKey',
    reason: 'Реестр расценок для смежного отдела: межсистемный ключ X-API-Key, только чтение, колонки перечислены в коде',
  },
  {
    method: 'GET', url: '/api/rates/*', kind: 'apiKey',
    reason: 'Реестр расценок для смежного отдела: межсистемный ключ X-API-Key, только чтение, колонки перечислены в коде',
  },
  {
    method: 'OPTIONS', url: '/api/rates', kind: 'open',
    reason: 'CORS-предзапрос к реестру расценок: данных не отдаёт',
  },
  {
    method: 'OPTIONS', url: '/api/rates/*', kind: 'open',
    reason: 'CORS-предзапрос к реестру расценок: данных не отдаёт',
  },
  // Свой вход (src/routes/auth.js): до входа сессии нет — эти три адреса открыты; остальные /api/auth/* — по сессии.
  { method: 'GET', url: '/api/auth/config', kind: 'open', reason: AUTH_CONFIG_REASON },
  { method: 'POST', url: '/api/auth/login', kind: 'open', reason: AUTH_LOGIN_REASON },
  { method: 'POST', url: '/api/auth/logout', kind: 'open', reason: AUTH_LOGOUT_REASON },
  // Регистрация подрядчика (src/routes/signup.js): пока регистрация закрыта, адреса отвечают 404.
  { method: 'GET', url: '/api/auth/register/challenge', kind: 'open', reason: SIGNUP_CHALLENGE_REASON },
  { method: 'POST', url: '/api/auth/register', kind: 'open', reason: SIGNUP_REGISTER_REASON },
  { method: 'POST', url: '/api/auth/register/preview', kind: 'open', reason: SIGNUP_PREVIEW_REASON },
  { method: 'POST', url: '/api/auth/register/confirm', kind: 'open', reason: SIGNUP_CONFIRM_REASON },
  { method: 'POST', url: '/api/auth/register/claim', kind: 'open', reason: SIGNUP_CLAIM_REASON },
  { method: 'POST', url: '/api/auth/password/forgot', kind: 'open', reason: PASSWORD_FORGOT_REASON },
  { method: 'POST', url: '/api/auth/password/reset', kind: 'open', reason: PASSWORD_RESET_REASON },
  // Обложки объектов (src/routes/covers.js): адрес картинки для <img>, токен он не передаёт.
  { method: 'GET', url: '/api/covers/:name', kind: 'open', reason: COVERS_OPEN_REASON },
  { method: 'GET', url: '/api/covers/:name/thumb', kind: 'open', reason: COVER_THUMBS_OPEN_REASON },
  // Шлюз данных (src/routes/dbGateway.js): вход и права проверяет сам. Без входа — только чтение таблиц,
  // выданных анониму на проде (список allow.json); строки анониму отдаёт лишь публичная витрина.
  // HEAD отдельной строкой не ведётся — как и у остальных маршрутов, он следует за GET.
  ...GATEWAY_METHODS.filter((m) => m !== 'HEAD').map((method) => ({ method, url: GATEWAY_URL, kind: 'open', reason: GATEWAY_REASON })),
]
