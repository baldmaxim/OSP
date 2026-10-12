-- Замена схемы auth из Supabase — ровно то, на что опирается схема public портала: «кто вошёл».
-- Тела функций те же, что в Supabase (слепок migration/schema/prod-schema.sql): ответ берётся из
-- настроек транзакции request.jwt.claims, которые ставит PostgREST по токену. Поэтому политики и
-- функции портала работают без правок.
-- Таблицы auth.users здесь нет: её заменяет отдельный шаг (вход), см. migration/PLAN.md.
-- Выполняется внутри общей транзакции загрузки (migration/target/load.sh).
CREATE SCHEMA auth;

CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

CREATE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

CREATE FUNCTION auth.jwt() RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  select
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$$;

CREATE FUNCTION auth.email() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

GRANT USAGE ON SCHEMA auth TO :"runtime_role";
