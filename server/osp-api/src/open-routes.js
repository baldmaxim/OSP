// Утверждённый список маршрутов, доступных без входа пользователя, — с обоснованием.
// Открытый маршрут не из этого списка сервер зарегистрировать откажется (src/lib/access.js), а тест
// tests/osp-api/access.test.mjs сверяет список со снимком в репозитории: новый открытый адрес — это
// решение, а не правка. Меняется вместе со снимком tests/osp-api/baseline/routes.json.
import { GATEWAY_METHODS, GATEWAY_URL, GATEWAY_REASON } from './routes/dbGateway.js'
import { COVERS_OPEN_REASON } from './routes/covers.js'

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
  // Обложки объектов (src/routes/covers.js): адрес картинки для <img>, токен он не передаёт.
  { method: 'GET', url: '/api/covers/:name', kind: 'open', reason: COVERS_OPEN_REASON },
  // Шлюз данных (src/routes/dbGateway.js): вход и права проверяет сам. Без входа — только чтение таблиц,
  // выданных анониму на проде (список allow.json); строки анониму отдаёт лишь публичная витрина.
  // HEAD отдельной строкой не ведётся — как и у остальных маршрутов, он следует за GET.
  ...GATEWAY_METHODS.filter((m) => m !== 'HEAD').map((method) => ({ method, url: GATEWAY_URL, kind: 'open', reason: GATEWAY_REASON })),
]
