# 02. Перенос БД в Yandex Managed PostgreSQL (фаза A)

## 1. Заявка владельцу кластера
- **База** `<portal>_db`: кодировка и collation как в Supabase (см. инвентаризацию), основная версия PG
  не ниже, чем в Supabase.
- **Роли.** В Yandex Managed PG пользователей создают через консоль или API кластера, `CREATE ROLE`
  недоступен:
  - `<portal>_migration` — владелец базы, схем и таблиц, выполняет DDL и миграции; приложение под ней
    не работает;
  - `<portal>_runtime` — только DML, не владеет ни одной таблицей (иначе RLS к ней не применяется), без
    права `CREATE`;
  - по желанию `<portal>_ro` — только чтение, для отчётов и диагностики.
- **Лимиты соединений.** `CONNECTION LIMIT` на роли считается так: (число процессов приложения × размер
  пула) × 2 на перекрытие старого и нового контейнера при деплое + миграции + запас.
- **Расширения** — по инвентаризации (`pgcrypto`, `pg_trgm`, `citext` и т. п.). Включает админ кластера в
  настройках базы; `CREATE EXTENSION` в схеме дампа не выполнять. `gen_random_uuid()` встроен в PG 13+.
- Пароли ролей — сразу в секрет-хранилище или env портала. В чат и в git не попадают.

Права runtime-роли выдаёт `<portal>_migration` миграцией:
```sql
grant usage on schema public, auth to <portal>_runtime;
grant select, insert, update, delete on all tables in schema public to <portal>_runtime;
grant usage, select on all sequences in schema public to <portal>_runtime;
grant execute on all functions in schema public, auth to <portal>_runtime;
alter default privileges for role <portal>_migration in schema public
  grant select, insert, update, delete on tables to <portal>_runtime;
alter default privileges for role <portal>_migration in schema public
  grant usage, select on sequences to <portal>_runtime;
```

## 2. Подключение приложения
- **Хост и порт.** Хост кластера, порт **6432** (пулер Odyssey, transaction mode).
- **TLS** — `sslmode=verify-full` с CA Яндекса (`https://storage.yandexcloud.net/cloud-certs/CA.pem`,
  положить в образ, например `/etc/yandex-pg/ca.crt`):
  - node-postgres: `ssl: { ca: fs.readFileSync(path), rejectUnauthorized: true }`;
  - postgres.js не читает `PGSSLROOTCERT` — CA передать в `ssl` явно или через `NODE_EXTRA_CA_CERTS`.
- **Ограничения transaction mode.** Между транзакциями соединение может смениться, поэтому:
  - без prepared statements: postgres.js `prepare: false`; Prisma `pgbouncer=true`; в node-postgres не
    задавать `name` у запросов;
  - без session-уровня: никаких `SET` вне транзакции, session advisory locks, `LISTEN/NOTIFY`, временных
    таблиц между транзакциями;
  - контекст запроса — только `set_config(..., true)` / `SET LOCAL` **внутри** транзакции.
- **Таймауты обязательны:**
  - `connect_timeout`, idle-timeout пула, TCP keepalive;
  - `statement_timeout` — настройкой роли (через владельца кластера) или `SET LOCAL` в транзакции;
  - health-check с `select 1`.
  
  Урок контура: пул соединений Keycloak за этим же пулером без таймаутов на сокете зависал на недели,
  при этом процесс считался живым.

## 3. Схема
1. Дамп схемы из Supabase:
   `pg_dump "$SUPABASE_DB_URL" --schema-only --schema=public --no-owner --no-privileges -f schema.sql`.
   Версия `pg_dump` — не ниже версии сервера.
2. Фильтр (sed или скрипт, результат `schema.filtered.sql`):
   - удалить `CREATE SCHEMA public` / `COMMENT ON SCHEMA public`;
   - удалить всё про схемы `auth|storage|realtime|extensions|graphql|graphql_public|vault|pgsodium|supabase_functions|supabase_migrations|net|cron|pgbouncer`;
   - удалить `CREATE EXTENSION …`: расширения включает админ кластера;
   - заменить `extensions.uuid_generate_v4()` → `gen_random_uuid()`, остальные `extensions.<fn>` → без
     префикса;
   - заменить `REFERENCES auth.users(id)` → `REFERENCES public.users(id)`;
   - удалить `GRANT`/`REVOKE`, `ALTER DEFAULT PRIVILEGES` на роли
     `anon|authenticated|service_role|authenticator|supabase_*|dashboard_user|postgres`;
   - в политиках `TO authenticated` / `TO anon` заменить на `TO <portal>_runtime`. Публичные (`anon`)
     политики пересмотреть: анонимного доступа к БД больше нет, только через API;
   - удалить публикацию `supabase_realtime`;
   - удалить строки `\restrict` / `\unrestrict` (новые `pg_dump`), если применяете не через `psql`;
     `SET transaction_timeout`, если целевой сервер старше PG 17.
3. Проверка фильтра: в файле не должно остаться неожиданных ссылок.
   ```bash
   grep -nE "auth\.users|extensions\.|storage\.|\b(anon|authenticated|service_role)\b" schema.filtered.sql
   ```
   Допустимы только вызовы `auth.uid()` / `auth.role()` / `auth.jwt()`: их обслуживает прослойка из §5.
4. Применить под `<portal>_migration` **после** создания `public.users` и прослойки `auth`.

## 4. Таблица пользователей вместо `auth.users`
Если есть `profiles` с `id = auth.users.id`, использовать её (добавить недостающие колонки). Иначе:
```sql
create table public.users (
  id             uuid primary key,             -- = прежний auth.users.id; никогда не генерировать заново
  email          text,                          -- снимок на момент переезда; НЕ ключ идентичности
  full_name      text,
  is_active      boolean not null default true,
  legacy_status  text,                          -- active | banned | deleted | unconfirmed (из Supabase)
  migrated_from  text,                          -- 'supabase' для прежних, null для новых
  created_at     timestamptz not null default now()
);
create index users_email_lower_idx on public.users (lower(email));
```
- Заполнить из `auth.users` **всеми** строками, включая удалённых и заблокированных
  (`is_active = false`): на них ссылается история.
- Хэши паролей в БД портала **не переносить**: они идут только в зашифрованный список для auth
  (`03-identity-mapping.md`).
- «Висячие» id из инвентаризации (есть в данных, нет в `auth.users`) — по решению человека: добавить
  строкой `is_active = false` или оставить колонку без FK.
- Логику триггера `handle_new_user` перенести в backend: создание пользователя при первом входе (JIT).

## 5. Прослойка `auth.uid()` — RLS продолжает работать
```sql
create schema if not exists auth authorization <portal>_migration;

create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

-- только если встречаются в политиках или функциях:
create or replace function auth.role() returns text language sql stable as
$$ select case when auth.uid() is null then 'anon' else 'authenticated' end $$;
create or replace function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('app.jwt_claims', true), ''), '{}')::jsonb $$;
```
- **`app.user_id` — всегда внутренний `users.id`, никогда не `sub` Keycloak.** Тогда прежние политики
  вида `owner_id = auth.uid()` дают людям доступ ровно к их записям.
- **Backend** в каждой транзакции первым делом выполняет
  `select set_config('app.user_id', $1, true)` (`04-oidc-bff.md`). Без этого `auth.uid()` = `null`, и
  политики ничего не отдают (fail-closed).
- **Роль приложения.** Приложение работает под `<portal>_runtime`. Владелец таблиц
  (`<portal>_migration`) обходит RLS, поэтому под ним приложение не запускать.
- **Системные задачи** (раньше `service_role`): явная ветка в политике, например
  `or current_setting('app.system', true) = 'on'`. Флаг ставится только в коде фоновых задач.
- **Проверка:** под runtime-ролью без `set_config` выборка из защищённой таблицы возвращает 0 строк, с
  `set_config` — записи этого пользователя.
- **Если RLS почти нет** — можно снять политики и проверять владельца в каждом запросе backend. Решение
  СТОП 1.

## 6. Данные
1. Репетиция — на стендовой базе, затем окно на проде.
2. Заморозить запись в Supabase на время окна: режим обслуживания портала, приложение не пишет.
3. Дамп данных:
   `pg_dump "$SUPABASE_DB_URL" --data-only --schema=public --no-owner --no-privileges -Fc -f data.dump`.
   Прямое подключение, не пулер Supabase в transaction mode.
4. `public.users` заполняется отдельным скриптом из `auth.users` (§4), до данных.
5. Restore без суперпользователя. `--disable-triggers` и `session_replication_role` не работают: restore
   выйдет частичным, часть таблиц окажется пустой. Порядок:
   - сохранить определения FK (`pg_get_constraintdef`) и снять их;
   - `alter table … disable trigger user` — пользовательские триггеры (`updated_at`, аудит); владельцу
     таблицы это разрешено;
   - `pg_restore --data-only --no-owner -j 4 -d "$TARGET_URL" data.dump`;
   - вернуть триггеры; вернуть FK как `NOT VALID`, затем `VALIDATE CONSTRAINT`.
6. Сверка:
   - точный `count(*)` по **каждой** таблице в Supabase и в новой базе;
   - `max(id)` против `last_value` последовательностей;
   - выборочные контрольные суммы ключевых таблиц.
7. Грабли переезда с PostgREST:
   - драйверы отдают `numeric`/`bigint` строкой (раньше было число): проверить арифметику и
     сериализацию;
   - уникальность email раньше гарантировал `auth.users`: поиск по email — только через `lower()`.
8. **Предохранитель.** Скрипты записи (миграции, restore, `apply-mapping`) отказываются работать, если
   хост цели похож на Supabase (`*.supabase.co`, `*.supabase.com`). Обход — только явным флагом.

## 7. Storage, Realtime, Edge Functions, cron
- **Storage** → Yandex Object Storage (S3 API): отдельная задача. Владельцем объекта остаётся
  внутренний `users.id`. Доступ к файлам — через backend (подписанные ссылки).
- **Realtime** → SSE/WebSocket backend. **Edge Functions** → эндпоинты backend. **cron** → планировщик в
  backend. **vault** → секрет-хранилище или env.

## 8. Откат фазы A
- Проект Supabase не удалять и не менять минимум 30 дней.
- Откат — переключить env портала обратно на Supabase. Записи, сделанные после переезда, теряются либо
  переносятся скриптом по `created_at` / `updated_at`. Какой вариант — решает человек **до** окна.
