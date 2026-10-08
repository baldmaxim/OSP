# 03. Сопоставление пользователей: сторона портала

Портал **поставляет данные и применяет решения**: он не решает, какой учётке Keycloak принадлежат
прежние записи. Цепочка такая:

```
Supabase auth.users ──export-portal-users──▶ su10-portal-users (шифр.) ──▶ команда auth
                                                                           │ сопоставляет, решает,
                                                                           │ заводит учётки, выдаёт доступ
БД портала: user_identity_links ◀──apply-mapping── su10-portal-mapping (шифр.) ◀┘
```

Форматы файлов и значения решений описаны в `05-auth-handoff.md`. Здесь — код и SQL портала.

## 1. Таблицы связей (миграция в БД портала)
```sql
create table public.user_identity_links (
  id               bigserial primary key,
  user_id          uuid not null references public.users(id),
  issuer           text not null,         -- https://auth.su10.ru/realms/su10
  subject          text not null,         -- sub Keycloak (text: формат sub не гарантирован)
  source           text not null,         -- 'mapping' (из файла auth) | 'jit' (новый пользователь)
  mapping_version  int,                   -- версия файла, из которого пришла связь
  linked_at        timestamptz not null default now(),
  last_seen_at     timestamptz,
  unique (issuer, subject),
  unique (issuer, user_id)                -- одна учётка Keycloak на одного пользователя портала
);

-- Последнее решение auth по каждому прежнему пользователю (в т.ч. без связи)
create table public.identity_mapping_state (
  legacy_user_id   uuid primary key references public.users(id),
  decision         text not null,         -- linked_existing | imported | imported_no_password | relink
                                          -- | not_migrated | duplicate_of | pending
  duplicate_of     uuid references public.users(id),
  mapping_version  int not null,
  note             text,
  updated_at       timestamptz not null default now()
);

-- Журнал применённых версий файла сопоставления
create table public.identity_mapping_applied (
  mapping_version  int primary key,
  content_sha256   text not null,
  rows             int not null,
  applied_at       timestamptz not null default now()
);
```
Runtime-роли достаточно `select/insert/update` на `user_identity_links` (JIT, `last_seen_at`). Две
другие таблицы пишет только CLI под `<portal>_migration`.

## 2. Выгрузка списка учёток — `export-portal-users`
Скрипт портала, например `scripts/identity/export-portal-users.ts`:
- **Источник.** Читает Supabase в read-only транзакции через `SUPABASE_DB_URL`.
- **Шифрование.** Собирает `su10-portal-users` (схема — `05-auth-handoff.md` §3) и шифрует конвертом из
  §3 ниже. Пароль шифрования читает из файла вне репозитория; путь — в env, например
  `PORTAL_MIGRATION_PASSPHRASE_FILE`.
- **Результат.** Пишет `migration/out/<portal>-users.<round>.enc.json` (`migration/out/` — в `.gitignore`).
- **Вывод в консоль — только счётчики:** всего, по статусам, с bcrypt / без пароля, с записями / без
  записей, `contentSha256`. Email, имена и хэши не печатать.
- **Раунды.** Аргумент `--round rehearsal|final`.

Основной запрос (поля имён адаптировать под портал: `profiles` или `raw_user_meta_data`):
```sql
select
  u.id                                          as legacy_user_id,
  u.email                                       as email,           -- как есть, без нормализации
  coalesce(p.first_name, u.raw_user_meta_data->>'first_name') as first_name,
  coalesce(p.last_name,  u.raw_user_meta_data->>'last_name')  as last_name,
  coalesce(p.full_name,  u.raw_user_meta_data->>'full_name')  as full_name,
  case when u.deleted_at is not null            then 'deleted'
       when u.banned_until > now()              then 'banned'
       when u.email_confirmed_at is null        then 'unconfirmed'
       else 'active' end                        as status,
  u.created_at, u.last_sign_in_at,
  coalesce((select array_agg(distinct i.provider order by i.provider)
            from auth.identities i where i.user_id = u.id), '{}') as providers,
  case when u.encrypted_password like '$2%' then u.encrypted_password end as password_hash
from auth.users u
left join public.profiles p on p.id = u.id;
```

Число записей пользователя — по утверждённым колонкам-владельцам (`01-inventory.md` §4):
```sql
select user_id, count(*) as owned from (
  select created_by as user_id from public.documents
  union all select owner_id from public.projects
  -- … все колонки-владельцы
) o where user_id is not null group by 1;
```

## 3. Конверт шифрования (тот же формат, что у выгрузок контура su10)
```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

type Format = 'su10-portal-users' | 'su10-portal-mapping';
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const MAXMEM = 64 * 1024 * 1024;

function key(passphrase: string, salt: Buffer) {
  if (passphrase.length < 16) throw new Error('пароль шифрования: не меньше 16 символов');
  return scryptSync(passphrase, salt, 32, { ...SCRYPT, maxmem: MAXMEM });
}

export function encryptEnvelope(format: Format, payload: unknown, rows: number, passphrase: string) {
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
  return {
    format, version: 1, createdAt: new Date().toISOString(), users: rows,
    contentSha256: createHash('sha256').update(plain).digest('hex'),
    kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    data: data.toString('base64'),
  };
}

export function decryptEnvelope(env: ReturnType<typeof encryptEnvelope>, expected: Format, passphrase: string) {
  if (env.format !== expected || env.version !== 1) throw new Error('неизвестный формат файла');
  const decipher = createDecipheriv('aes-256-gcm', key(passphrase, Buffer.from(env.kdf.salt, 'base64')),
    Buffer.from(env.cipher.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.cipher.tag, 'base64'));
  const plain = gunzipSync(Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]));
  if (createHash('sha256').update(plain).digest('hex') !== env.contentSha256) throw new Error('контрольная сумма не сходится');
  return JSON.parse(plain.toString('utf8'));
}
```
Пароль: один на миграцию, не короче 16 символов. Его генерирует команда портала и передаёт auth
**другим каналом**, чем сами файлы. Auth шифрует ответ тем же паролем.

## 4. Применение решений — `apply-mapping`
`apply-mapping --file migration/in/<portal>-mapping.v<N>.enc.json [--dry-run] [--report <путь>]`,
под `<portal>_migration`, с предохранителем «цель — не Supabase».

1. **Проверка файла.** Расшифровать и проверить `portal`, а также `issuer` = `OIDC_ISSUER`
   (`05-auth-handoff.md` §4). Каждая версия файла **полная**: в ней все строки, а не дельта.
2. **Блокировка** — `pg_advisory_xact_lock(hashtext('apply-mapping'))` внутри транзакции.
3. **Версия:**
   - версия уже применена с тем же `contentSha256` → ничего не делать;
   - та же версия с другим хэшем или версия ниже последней применённой → ошибка.
4. **Проверки** (любая ошибка → выход без записи, даже без `--dry-run`):
   - каждый `legacyUserId` есть в `public.users`;
   - каждый `sub` встречается в файле не больше одного раза;
   - `linked_existing` / `imported` / `imported_no_password` / `relink` — `sub` обязателен;
   - `imported*` с `sub ≠ legacyUserId` — предупреждение в отчёте (так быть не должно);
   - пользователь уже связан с **другим** `sub` → конфликт `user_linked_elsewhere`. Исключение —
     `relink` с совпадающим `previousSub`;
   - `sub` уже связан с **другим** пользователем → конфликт `sub_taken`;
   - у пользователя есть связь, а решение `not_migrated` / `pending` / `duplicate_of` → конфликт
     (снимать связи молча нельзя);
   - `duplicate_of` указывает на существующего пользователя, у которого решение со `sub`.
5. **План действий** по каждой строке: `insert_link` / `relink` / `noop` / `state_only`. Плюс список
   прежних пользователей (`migrated_from = 'supabase'`), которых **нет в файле**, — `missing_in_mapping`.
6. **Отчёт** (`--report`, вне git; в консоль — только счётчики):
   - число строк по каждому `decision` и каждому действию;
   - конфликты (только id);
   - «записи под риском» — сумма записей пользователей с `not_migrated` / `pending` / `missing_in_mapping`.
7. **СТОП:** отчёт `--dry-run` показать человеку. Применять только после «да».
8. **Запись** — одна транзакция: `user_identity_links` (`source='mapping'`, `mapping_version`),
   upsert в `identity_mapping_state`, строка в `identity_mapping_applied`.

Конфликты разрешает **команда auth новой версией файла**. Портал не правит связи руками.

## 5. `duplicate_of` — перенос владения
У человека было две учётки в Supabase. Auth выбрал основную (primary), вторая (secondary) помечена
`duplicate_of`. Отдельный скрипт `merge-duplicates [--dry-run]`:
1. По каждой колонке-владельцу посчитать `count(*) where <col> = secondary`.
2. Проверить уникальные ключи, где участвует колонка: например, `(project_id, user_id)` у участников
   проекта. Коллизии вывести списком.
3. **СТОП:** человек решает судьбу коллизий и подтверждает.
4. Выполнить `update <t> set <col> = primary where <col> = secondary`. Второй учётке поставить
   `is_active = false` и `legacy_status = 'merged'`. Всё в одной транзакции.

## 6. Резолв пользователя при входе и на каждом запросе
Claims access token уже проверены (`04-oidc-bff.md`).
```
resolveUser(claims):
  if 'access' not in claims.resource_access[<portal>].roles → 403 no_access
  link = links.find(issuer, claims.sub)
  if link:
      user = users.get(link.user_id)
      if not user.is_active → 403 disabled
      touch link.last_seen_at (не чаще раза в N минут)
      return user
  # связи нет
  legacy = select id from users
           where migrated_from = 'supabase' and lower(email) = lower(claims.email)
             and not exists (select 1 from user_identity_links l where l.user_id = users.id)
  if legacy:
      log.warn('pending_mapping', { sub, legacyUserId })   # без email в логе
      → 403 pending_mapping   # «учётка ожидает сопоставления, обратитесь в поддержку»
                              # НЕ привязывать: решение за командой auth
  # действительно новый человек — JIT
  in tx: insert users(id = gen_random_uuid(), email, full_name, migrated_from = null)
         insert user_identity_links(issuer, sub, user_id, source = 'jit')
         on conflict (issuer, subject) → откатить и перечитать связь
  return user
```
- Кэш результата по `sub` — секунды, не минуты. Сбрасывать при деактивации пользователя.
- Каждая транзакция запроса начинается с `set_config('app.user_id', user.id, true)`.

## 7. Проверка покрытия (после каждого `apply-mapping`)
```sql
-- У кого есть записи, но нет связи: эти люди сейчас не видят свои данные
with owners as (
  select created_by as user_id from public.documents
  union all select owner_id from public.projects
  -- … все колонки-владельцы
)
select u.id, u.legacy_status, s.decision, count(*) as records
from owners o
join public.users u on u.id = o.user_id
left join public.user_identity_links l on l.user_id = u.id
left join public.identity_mapping_state s on s.legacy_user_id = u.id
where l.id is null
group by 1, 2, 3
order by records desc;
```
Ожидаемо без связи остаются только `not_migrated`, вторые учётки из `duplicate_of` (после переноса у
них 0 записей) и неактивные. Остальное — вопрос в auth.

После переключения полезно смотреть долю связанных прежних пользователей с заполненным `last_seen_at`:
сколько людей уже вошли через Keycloak.
