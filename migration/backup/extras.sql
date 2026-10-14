-- Всё, что из Supabase переносится кроме схемы public (её снимает pg_dump в backup.sh), и опись того,
-- что не переносится. Одна транзакция «только чтение» с одним снимком: числа описи и строки выгрузок
-- согласованы между собой. Запускает backup.sh:
--   psql -v users_file=… -v identities_file=… -v covers_file=… -v inventory_file=… -f extras.sql
--
-- Учётные записи — по явному списку колонок, без паролей: в новом портале вход через Keycloak по паролю
-- ФОТ, отпечатки паролей Supabase не нужны (решение владельца от 2026-10-14). Одноразовые коды из писем
-- (confirmation_token, recovery_token, email_change_token_*, phone_change_token, reauthentication_token)
-- тоже не выгружаются: это действующие ключи, а не данные. Колонки списка, которых в этой версии Supabase
-- нет, пропускаются; без обязательных (id, email, created_at, updated_at) выгрузка падает.
-- Формат времени задан явно (UTC, ISO): сверка после загрузки сравнивает выгрузки побайтно.
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TimeZone = 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL IntervalStyle = 'postgres';
SET LOCAL extra_float_digits = 1;
-- Правило по строкам не может молча скрыть строки: при нём запрос падает, а не отдаёт часть.
SET LOCAL row_security = off;

SELECT
  (SELECT string_agg(pg_catalog.quote_ident(a.attname), ', ' ORDER BY a.attnum)
   FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'auth.users'::regclass AND NOT a.attisdropped AND a.attname = ANY (ARRAY[
     'id', 'aud', 'role', 'email', 'email_confirmed_at', 'invited_at',
     'confirmation_sent_at', 'recovery_sent_at', 'email_change', 'email_change_sent_at', 'last_sign_in_at',
     'raw_app_meta_data', 'raw_user_meta_data', 'is_super_admin', 'created_at', 'updated_at', 'phone',
     'phone_confirmed_at', 'phone_change', 'phone_change_sent_at', 'email_change_confirm_status',
     'banned_until', 'reauthentication_sent_at', 'is_sso_user', 'deleted_at', 'is_anonymous'])) AS user_cols,
  (SELECT count(*) FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'auth.users'::regclass AND NOT a.attisdropped
     AND a.attname = ANY (ARRAY['id', 'email', 'created_at', 'updated_at'])) AS user_required,
  (SELECT string_agg(pg_catalog.quote_ident(a.attname), ', ' ORDER BY a.attnum)
   FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'auth.identities'::regclass AND NOT a.attisdropped AND a.attname = ANY (ARRAY[
     'id', 'user_id', 'provider', 'provider_id', 'identity_data', 'last_sign_in_at', 'created_at', 'updated_at'])) AS identity_cols,
  (SELECT count(*) FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'auth.identities'::regclass AND NOT a.attisdropped
     AND a.attname = ANY (ARRAY['id', 'user_id', 'provider', 'identity_data'])) AS identity_required
\gset
SELECT (:user_required = 4 AND :identity_required = 4) AS columns_ok \gset
\if :columns_ok
\else
  \echo 'FAIL в auth.users или auth.identities нет обязательных колонок — выгрузка учёток невозможна'
  SELECT 1/0;
\endif

COPY (SELECT :user_cols FROM auth.users ORDER BY id) TO STDOUT WITH (FORMAT csv, HEADER true) \g :users_file
COPY (SELECT :identity_cols FROM auth.identities ORDER BY user_id, provider, id) TO STDOUT WITH (FORMAT csv, HEADER true) \g :identities_file

-- Обложки объектов: бакет object-photos. Сами файлы копирует server/osp-api/scripts/covers-copy.js.
COPY (
  SELECT o.name, (o.metadata ->> 'size')::bigint AS size, o.metadata ->> 'mimetype' AS mimetype, o.created_at, o.updated_at
  FROM storage.objects o
  WHERE o.bucket_id = 'object-photos'
  ORDER BY o.name
) TO STDOUT WITH (FORMAT csv, HEADER true) \g :covers_file

-- Опись: каждая таблица каждой схемы, кроме системных, с точным числом строк. Строки storage.objects —
-- по бакетам, cron.job — по именам расписаний: «что именно лежит», а не одно общее число.
-- Нет права чтения — число -1: такая таблица тоже должна быть разобрана в описи.
SELECT CASE WHEN to_regclass('cron.job') IS NULL THEN false
            ELSE pg_catalog.has_table_privilege('cron.job', 'SELECT') END AS cron_readable \gset
\if :cron_readable
  \set cron_rows 'SELECT format(''cron.job[%s]'', jobname), count(*) FROM cron.job GROUP BY jobname'
\else
  \set cron_rows 'SELECT ''cron.job'', -1::bigint WHERE to_regclass(''cron.job'') IS NOT NULL'
\endif
COPY (
  SELECT name, n FROM (
    SELECT format('%s.%s', n.nspname, c.relname) AS name,
           CASE WHEN pg_catalog.has_table_privilege(c.oid, 'SELECT')
                THEN (pg_catalog.xpath('/row/n/text()', pg_catalog.query_to_xml(
                        format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint
                ELSE -1 END AS n
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp)'
      AND NOT (n.nspname = 'storage' AND c.relname = 'objects')
      AND NOT (n.nspname = 'cron' AND c.relname = 'job')
    UNION ALL
    SELECT format('storage.objects[%s]', bucket_id), count(*) FROM storage.objects GROUP BY bucket_id
    UNION ALL
    :cron_rows
  ) x
  ORDER BY name
) TO STDOUT \g :inventory_file
COMMIT;
