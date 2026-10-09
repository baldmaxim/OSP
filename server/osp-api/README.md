# osp-api — свой API портала ОСП

Этап 3 переезда (`migration/PLAN.md`): трафик браузера и внешних потребителей переводится с Supabase на
свой сервис. Сейчас здесь три маршрута вместо Edge Functions Supabase. Данные пока берутся из
Supabase; при переносе базы меняется только источник, маршруты остаются.

| Маршрут | Вместо | Доступ |
|---|---|---|
| `POST /api/fn/s3-presign` | Edge Function `s3-presign` | токен пользователя Supabase; одобренный; подрядчик — только скачивание файлов своих договоров |
| `POST /api/fn/ai-assist` | Edge Function `ai-assist` | токен; **только одобренный сотрудник** (функция пускала любого вошедшего) |
| `GET /api/rates/{kp,supply,health}` | Edge Function `rates-api` | ключ `X-API-Key` или `?key=` (`RATES_API_KEYS`) |
| `GET /api/health` | — | без доступа; показывает только «задано / не задано» для настроек |

Запросы, ответы, коды и тексты ошибок — как у функций, это проверяют `tests/osp-api`. Задуманных отличий
два:
- `ai-assist` закрыт для неодобренных и подрядчиков;
- `rates-api` без `limit` / `price_min` / `price_max` работает по документации. В функции `Number(null)`
  давало 0: без параметров выдача шла по 1 строке и только с ценой 0.

**Безопасность.**
- Строки базы (`user_roles`, `s3_documents`, `is_my_contract`) читаются под токеном пользователя, поэтому
  действует тот же RLS, что в браузере.
- Служебный ключ Supabase используется только в `/api/rates`.
- В журнал пишутся метод, шаблон маршрута, код и время. Адреса с `?key=`, заголовки и тела запросов
  (в них текст договоров) в журнал не попадают.

## Включение на портале

Фронт вызывает функции через `invokeFunction` (`src/api/functions.js`). Флаг `ospApiFunctions` переводит
вызовы на `/api/fn/<имя>`, без него работают Edge Functions Supabase.
- **Один браузер (проверка на проде):** открыть `https://osp.root.sx/?features=ospApiFunctions`.
  Снять флаг: `?features=-ospApiFunctions`.
- **Все пользователи:** `/var/www/osp/shared/config.json` → `{"features": {"ospApiFunctions": true}}`.
  Откат — `false`, без пересборки.

## Запуск

```bash
npm ci --prefix server/osp-api              # зависимости — ровно по package-lock.json
PORT=8787 node server/osp-api/src/server.js # настройки — переменные окружения, см. osp-api.env.example
npm run test:api                            # тесты (MinIO в Docker — если есть образ)
```

На VPS osp-api работает как служба `deploy/osp-api.service`, выкладывается скриптом `deploy/api-deploy.sh`
и доступен через nginx `location ^~ /api/`. Всё это описано в `docs/DEPLOYMENT.md`, раздел «Свой API
(osp-api)».
