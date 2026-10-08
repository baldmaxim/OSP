# 01. Инвентаризация Supabase

Цель — до любых правок узнать, что из Supabase реально используется и сколько у портала
пользователей и «записей пользователя». Результат — `migration/inventory.md` в репозитории портала:
только счётчики и имена объектов, **без email, хэшей и ключей**.

## Подключение к Supabase — только чтение
- Прямое подключение к PG проекта: строка подключения в env, например `SUPABASE_DB_URL`. Значение не
  выводить.
- Каждый сеанс — только на чтение:
  `PGOPTIONS='-c default_transaction_read_only=on' psql "$SUPABASE_DB_URL" -f query.sql`
  или `BEGIN TRANSACTION READ ONLY; … ROLLBACK;`.
- Поле `auth.users.encrypted_password` через PostgREST/supabase-js недоступно — нужен только прямой PG.

## 1. Код портала
```bash
rg -n "@supabase/|createClient\(" --glob '!node_modules' --glob '!dist'
rg -n "supabase\.(from|rpc|storage|auth|channel|functions|removeChannel)\b" --glob '!node_modules'
rg -n "\.auth\.(getUser|getSession|onAuthStateChange|signIn\w*|signUp|signOut|resetPasswordForEmail|updateUser|admin)" --glob '!node_modules'
# только имена переменных, не значения:
rg -n -o "(NEXT_PUBLIC_|VITE_)?SUPABASE_[A-Z_]+" --glob '!node_modules' | sort -u
```
Также посмотреть каталог `supabase/`: `migrations/`, `functions/` (Edge Functions), `config.toml`.

Записать в инвентаризацию:
- где браузер ходит в таблицы напрямую (`from`), где вызывает RPC (`rpc`);
- где используется Storage, Realtime, Edge Functions;
- какие auth-вызовы есть: вход, регистрация, сброс пароля, admin.

## 2. Схема БД
```sql
-- Таблицы и примерный объём
select relname, n_live_tup from pg_stat_user_tables where schemaname = 'public' order by 1;

-- FK на auth.users (их перенацелим на public.users)
select conrelid::regclass as tbl, conname, pg_get_constraintdef(oid) as def
from pg_constraint where contype = 'f' and confrelid = 'auth.users'::regclass;

-- uuid-колонки, похожие на ссылку на пользователя, но без FK (кандидаты в «колонки-владельцы»)
select table_name, column_name from information_schema.columns
where table_schema = 'public' and data_type = 'uuid'
  and column_name ~ '(user|owner|author|creat|updat|assign|approv|manager|member)'
order by 1, 2;

-- RLS: на каких таблицах включён, какие политики
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' order by 1;
select tablename, policyname, roles, cmd, qual, with_check
from pg_policies where schemaname = 'public' order by 1, 2;

-- Функции, представления и DEFAULT, завязанные на auth.*
select p.proname, p.prosecdef
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind in ('f', 'p')
  and pg_get_functiondef(p.oid) ~ 'auth\.(uid|jwt|role|email|users)';
select table_name from information_schema.views
where table_schema = 'public' and view_definition ~ 'auth\.';
select table_name, column_name, column_default from information_schema.columns
where table_schema = 'public' and column_default ~ '(auth|extensions)\.';

-- Триггеры на auth.users (типично handle_new_user → profiles)
select tgname, pg_get_triggerdef(t.oid) from pg_trigger t
where tgrelid = 'auth.users'::regclass and not tgisinternal;

-- Расширения и их схемы (в Supabase многие живут в схеме extensions)
select e.extname, e.extversion, n.nspname
from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1;

-- Вебхуки / pg_net / cron / realtime
select event_object_table, trigger_name from information_schema.triggers
where action_statement ~ '(supabase_functions|net\.)';
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
-- если схема cron есть:
select jobname, schedule from cron.job;
-- vault: только имена, не значения
select name from vault.secrets;

-- Storage
select id, public from storage.buckets;
select bucket_id, count(*), pg_size_pretty(sum((metadata->>'size')::bigint)) from storage.objects group by 1;

-- Параметры базы
select version();
select datcollate, datctype from pg_database where datname = current_database();
show timezone;
```

## 3. Пользователи (только счётчики)
```sql
select
  count(*)                                                                   as total,
  count(*) filter (where deleted_at is not null)                             as deleted,
  count(*) filter (where banned_until > now())                               as banned,
  count(*) filter (where email_confirmed_at is null)                         as unconfirmed,
  count(*) filter (where is_sso_user)                                        as sso,
  count(*) filter (where is_anonymous)                                       as anonymous,  -- колонки может не быть
  count(*) filter (where email is null)                                      as no_email,
  count(*) filter (where encrypted_password like '$2%')                      as bcrypt,
  count(*) filter (where coalesce(encrypted_password, '') = '')              as no_password,
  count(*) filter (where last_sign_in_at > now() - interval '180 days')      as signed_in_180d
from auth.users;

select provider, count(*) from auth.identities group by 1 order by 2 desc;

-- Дубли email без учёта регистра — только количество
select count(*) from (
  select lower(trim(email)) from auth.users where email is not null group by 1 having count(*) > 1
) d;

-- Есть ли таблица профилей с id = auth.users.id
select table_name from information_schema.columns
where table_schema = 'public' and column_name = 'id'
  and table_name in ('profiles', 'users', 'user_profiles');
```

## 4. Колонки-владельцы и «записи пользователя»
Из FK на `auth.users` и найденных uuid-колонок выбрать **колонки-владельцы**: по ним определяется,
чьи это записи, и по ним RLS даёт доступ. Например `documents.created_by`, `projects.owner_id`,
`project_members.user_id`. Список утверждает человек.

Дальше этот список нужен в трёх местах:
- в выгрузке для auth (`ownedRecords`);
- в проверке покрытия после `apply-mapping`;
- в скрипте `duplicate_of`.

Проверка «висячих» id — значений, которых нет в `auth.users`:
```sql
select count(*) from public.documents d
where d.created_by is not null and not exists (select 1 from auth.users u where u.id = d.created_by);
```

## 5. Что записать в `migration/inventory.md`
1. Версия PG, collation, timezone, расширения.
2. Таблицы и объёмы.
3. FK на `auth.users`; колонки-владельцы (утверждённый список).
4. RLS: таблицы, политики, роли в `TO …`. Функции, представления и DEFAULT с `auth.*`.
5. Триггеры на `auth.users` — их логика переедет в backend (JIT-создание пользователя).
6. Storage (бакеты, объём), Realtime, Edge Functions, cron, вебхуки, vault — что и чем заменяем.
7. Счётчики пользователей, провайдеры входа, дубли email.
8. Решения СТОП 1: RLS-прослойка или проверки в приложении; одно окно или две фазы.
