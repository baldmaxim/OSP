# 04. Backend: OIDC/BFF с Keycloak su10

Паттерн BFF: Authorization Code + PKCE выполняет backend. Токены живут только в httpOnly-cookie, браузер
их не видит. Клиент `<portal>` заводит команда auth (`05-auth-handoff.md`). Админских прав в Keycloak
порталу не нужно.

## 1. Режимы и переменные окружения
Режим входа — флаг `AUTH_MODE`, чтобы откатываться без пересборки:
- `supabase` — фаза A: фронт входит через Supabase Auth, backend проверяет JWT Supabase;
- `keycloak` — фаза B.

```
AUTH_MODE=supabase|keycloak
OIDC_ISSUER=https://auth.su10.ru/realms/su10
OIDC_CLIENT_ID=<portal>
OIDC_CLIENT_SECRET=***                      # только env/секрет-хранилище
OIDC_REDIRECT_URI=https://<portal-domain>/api/auth/oidc/callback
OIDC_POST_LOGOUT_REDIRECT_URI=https://<portal-domain>/
OIDC_SCOPES=openid email profile
CSRF_SECRET=***
# фаза A (Supabase Auth):
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_JWT_SECRET=***                     # только если проект подписывает JWT по HS256
```

Публичный `GET /api/auth/config` → `{ mode, loginUrl }`: фронт сам выбирает, как входить.

## 2. Эндпоинты (Node, `openid-client` v6 + `jose`)
```ts
import * as oidc from 'openid-client';
const config = await oidc.discovery(
  new URL(env.OIDC_ISSUER), env.OIDC_CLIENT_ID, undefined, oidc.ClientSecretPost(env.OIDC_CLIENT_SECRET));
```
**`GET /api/auth/login?returnTo=/path`**
- `code_verifier = oidc.randomPKCECodeVerifier()`,
  `code_challenge = await oidc.calculatePKCECodeChallenge(code_verifier)`, `state`, `nonce`.
- Положить `{code_verifier, state, nonce, returnTo}` в cookie `kc_login`: httpOnly, Secure,
  `SameSite=Lax`, `Path=/api/auth`, 5 минут.
- `returnTo` — только относительный путь (начинается с `/`, но не с `//`).
- Редирект на
  `oidc.buildAuthorizationUrl(config, { redirect_uri, scope, code_challenge, code_challenge_method: 'S256', state, nonce })`.

**`GET /api/auth/oidc/callback`**
- **URL для обмена.** `currentUrl` собрать из `OIDC_REDIRECT_URI` и query-строки запроса. За nginx
  `req.url` относительный и с `http`, такой URL не годится.
- **Обмен кода:**
  `tokens = await oidc.authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier, expectedState, expectedNonce, idTokenExpected: true })`.
- **Проверка access token и резолв.** Access token проверить как в §3 и резолвить пользователя
  (`03-identity-mapping.md` §6). При 403 (`no_access` / `pending_mapping` / `disabled`) cookie не
  ставить, а редиректнуть на страницу фронта с кодом.
- **Cookie** (все httpOnly, Secure):
  - `access_token` (`Path=/`, `max-age` = `expires_in`);
  - `refresh_token` (`Path=/api/auth`);
  - `id_token` (`Path=/api/auth`, нужен как `id_token_hint` при выходе).
- Стереть `kc_login`, редирект на `returnTo`.

**`POST /api/auth/refresh`** — `oidc.refreshTokenGrant(config, refresh_token)` → перезаписать cookie.
Фронт вызывает его на 401 и повторяет исходный запрос один раз. Access token живёт 5 минут.

**`POST /api/auth/logout`** — стереть cookie и вернуть
`{ logoutUrl: oidc.buildEndSessionUrl(config, { id_token_hint, post_logout_redirect_uri }) }`. Фронт
делает `window.location.assign(logoutUrl)`. Без `id_token_hint` Keycloak показывает страницу
подтверждения выхода.

**`GET /api/auth/me`** — профиль и бизнес-роли **из БД портала**.

## 3. Проверка на каждом запросе
```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';
const JWKS = createRemoteJWKSet(new URL(`${env.OIDC_ISSUER}/protocol/openid-connect/certs`));

const { payload } = await jwtVerify(accessToken, JWKS, { issuer: env.OIDC_ISSUER, audience: env.OIDC_CLIENT_ID });
if (payload.azp !== env.OIDC_CLIENT_ID) throw unauthorized();
const roles = (payload.resource_access as Record<string, { roles?: string[] }> | undefined)?.[env.OIDC_CLIENT_ID]?.roles ?? [];
```
- Дальше — `resolveUser` (`03-identity-mapping.md` §6): роль `access`, связь по `(issuer, sub)`,
  `is_active`.
- `email_verified` **не** проверять: у сотрудников из ФОТ он `false`.
- Client-роли из токена для бизнес-авторизации не использовать — только гейт `access`.
- Изменение роли `access` в Keycloak вступает в силу со следующим access token, то есть в пределах
  5 минут.

## 4. Контекст БД для RLS
Каждый запрос к БД — в транзакции, первым оператором ставится внутренний id:
```ts
// postgres.js (prepare: false для пулера 6432)
export function withUser<T>(userId: string, fn: (tx: postgres.TransactionSql) => Promise<T>) {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  });
}
```
- В `app.user_id` — **`users.id`, не `sub`**.
- Прямые обращения к пулу в обход `withUser` запретить: ревью или правило линтера.
- Фоновые задачи — отдельной обёрткой с `app.system = on`, если это предусмотрено политиками.

## 5. Фаза A: вход ещё через Supabase Auth
- **Фронт** получает сессию через supabase-js (только auth, без `from`/`rpc`) и шлёт
  `Authorization: Bearer <access_token>` на API портала.
- **Backend проверяет JWT Supabase:**
  - проекты с асимметричными ключами — по JWKS `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
  - старые проекты — HS256 с `SUPABASE_JWT_SECRET`;
  - `iss = ${SUPABASE_URL}/auth/v1`, `aud = authenticated`.
- **`sub` JWT Supabase = внутренний `users.id`**: таблица связей не нужна, `set_config` получает `sub`
  напрямую.
- **Новый пользователь Supabase** (в фазе A регистрация ещё открыта): строка `users` создаётся при
  первом запросе — это замена триггера `handle_new_user`.

## 6. Фронтенд
- Убрать supabase-js полностью к концу фазы B. Все запросы — `fetch('/api/…', { credentials: 'include' })`.
- Изменяющие запросы несут CSRF-токен (double-submit cookie + заголовок). CSRF работает и в режиме
  `keycloak`.
- **Фронт и API на разных доменах:** cookie `SameSite=None; Secure`, CORS с `credentials` и точным
  origin. **На одном домене:** `SameSite=Lax`.
- **Страницы ошибок:**
  - `no_access` — «нет доступа к порталу, обратитесь к администратору»;
  - `pending_mapping` — «учётная запись ожидает сопоставления, обратитесь в поддержку портала»;
  - `disabled`.
- Сброс пароля и регистрация в портале больше не живут: в su10 их выполняет администратор auth. Ссылки
  «забыли пароль» ведут на инструкцию, а не на Supabase.

## 7. Сеть, наблюдаемость, безопасность
- **Сеть.** Backend ходит только на публичный `https://auth.su10.ru/realms/su10/...`: discovery, token,
  JWKS, end-session. `iss` в токенах — публичный URL, внутренние адреса Keycloak не использовать.
- **Readiness.** При старте и в `/health/ready` проверять доступность discovery и JWKS.
- **Логи.** Никогда не логировать `code`, `code_verifier`, токены, cookie, `client_secret`. В логах
  резолва — `sub` и `users.id`, без email.
- **Откат.** `AUTH_MODE=supabase` возвращает вход через Supabase, пока проект Supabase жив и его
  пользователи не менялись. Пользователи, созданные через JIT в режиме `keycloak`, в режиме `supabase`
  войти не смогут: это осознанная цена отката.
