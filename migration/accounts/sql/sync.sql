-- Перенос учёток и паролей из выгрузки Supabase в базу нового портала (accounts-sync.sh). Одна транзакция:
-- либо всё, либо ничего; в режиме проверки — откат в конце. Переменные psql:
--   copy_file               — команды \copy: выгрузка учёток (migration/backup/extras.sql, колонки из закрытого
--                             списка) в in_users и пароли, уже зашифрованные ключом сервера (prepare.mjs), в in_cred;
--   canary, fingerprint, users_sha — канарейка ключа, отпечаток учёток выгрузки, sha256 файла учёток;
--   restore_id, has_restore — вернуть одну удалённую администратором учётку (снять надгробие);
--   commit                  — true: записать; false: только отчёт.
-- Учётки и сессии — с отметкой osp:internal, пароли и надгробия — с osp:auth (её пропуск служебных функций
-- не открывает). В отчёт — только имена счётчиков и числа.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '300s';
SET LOCAL application_name = 'osp:internal';

CREATE TEMP TABLE in_users (
  id text, aud text, role text, email text, email_confirmed_at text, invited_at text, confirmation_sent_at text,
  recovery_sent_at text, email_change text, email_change_sent_at text, last_sign_in_at text, raw_app_meta_data text,
  raw_user_meta_data text, is_super_admin text, created_at text, updated_at text, phone text, phone_confirmed_at text,
  phone_change text, phone_change_sent_at text, email_change_confirm_status text, banned_until text,
  reauthentication_sent_at text, is_sso_user text, deleted_at text, is_anonymous text
) ON COMMIT DROP;
CREATE TEMP TABLE in_cred (user_id uuid PRIMARY KEY, secret text NOT NULL, supabase_sha256 text NOT NULL) ON COMMIT DROP;
-- \copy не подставляет переменные psql: команды с проверенными путями готовит accounts-sync.sh.
\i :copy_file
CREATE TEMP TABLE rep (k text PRIMARY KEY, n bigint NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE t_changed (user_id uuid PRIMARY KEY) ON COMMIT DROP;

-- Надгробия и нынешние пароли — с отметкой osp:auth, во временные таблицы (у них правил нет).
SET LOCAL application_name = 'osp:auth';
\if :has_restore
DELETE FROM osp_auth.tombstones WHERE user_id = :'restore_id'::uuid;
\endif
CREATE TEMP TABLE t_tomb ON COMMIT DROP AS SELECT user_id FROM osp_auth.tombstones;
CREATE TEMP TABLE t_cred ON COMMIT DROP AS SELECT user_id, source, supabase_sha256 FROM osp_auth.credentials;
SET LOCAL application_name = 'osp:internal';

-- Удалённые в Supabase (deleted_at) и надгробия не переносятся.
CREATE TEMP TABLE t_in ON COMMIT DROP AS
  SELECT i.* FROM in_users i WHERE i.deleted_at IS NULL AND i.id::uuid NOT IN (SELECT user_id FROM t_tomb);

-- Одна почта — одна учётка: дубли (после нормализации) среди приходящих и оставшихся — остановка до записи.
INSERT INTO rep
SELECT 'dup_emails', count(*) FROM (
  SELECT e FROM (
    SELECT i.id::uuid AS id, osp_private.email_norm(i.email) AS e FROM t_in i
    UNION
    SELECT u.id, osp_private.email_norm(u.email) FROM auth.users u WHERE u.id NOT IN (SELECT id::uuid FROM t_in)
  ) c WHERE e IS NOT NULL GROUP BY e HAVING count(DISTINCT id) > 1) d;
SELECT (SELECT n FROM rep WHERE k = 'dup_emails') > 0 AS osp_dups \gset
\if :osp_dups
ROLLBACK;
\echo OSP_SYNC_FAIL_DUP_EMAILS
\quit
\endif

WITH ins AS (
  INSERT INTO auth.users (id, aud, role, email, email_confirmed_at, last_sign_in_at, created_at, updated_at, raw_user_meta_data)
  SELECT i.id::uuid, i.aud, i.role, i.email, i.email_confirmed_at::timestamptz, i.last_sign_in_at::timestamptz,
         i.created_at::timestamptz, i.updated_at::timestamptz, nullif(i.raw_user_meta_data, '')::jsonb
  FROM t_in i WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = i.id::uuid)
  RETURNING 1)
INSERT INTO rep SELECT 'users_new', count(*) FROM ins;

WITH upd AS (
  UPDATE auth.users u SET email = i.email, email_confirmed_at = i.email_confirmed_at::timestamptz,
         raw_user_meta_data = nullif(i.raw_user_meta_data, '')::jsonb,
         updated_at = greatest(u.updated_at, i.updated_at::timestamptz),
         last_sign_in_at = greatest(u.last_sign_in_at, i.last_sign_in_at::timestamptz)
  FROM t_in i
  WHERE u.id = i.id::uuid
    AND (u.email IS DISTINCT FROM i.email OR u.email_confirmed_at IS DISTINCT FROM i.email_confirmed_at::timestamptz
         OR u.raw_user_meta_data IS DISTINCT FROM nullif(i.raw_user_meta_data, '')::jsonb)
  RETURNING 1)
INSERT INTO rep SELECT 'users_updated', count(*) FROM upd;

INSERT INTO rep SELECT 'users_tombstoned_skipped', count(*) FROM in_users i
  WHERE i.id::uuid IN (SELECT user_id FROM t_tomb) AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = i.id::uuid);
INSERT INTO rep SELECT 'users_deleted_in_supabase_skipped', count(*) FROM in_users i WHERE i.deleted_at IS NOT NULL;
INSERT INTO rep SELECT 'users_only_in_new_portal', count(*) FROM auth.users u WHERE u.id NOT IN (SELECT id::uuid FROM in_users);
INSERT INTO rep SELECT 'roles_without_account', count(*) FROM public.user_roles r WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = r.user_id);
CREATE TEMP TABLE t_users ON COMMIT DROP AS SELECT id FROM auth.users;

-- Пароли. Новые — вставка; изменённые в Supabase после прошлой копии (сумма отпечатка другая) — замена только у паролей из
-- Supabase; сменённые или пересчитанные в новом портале (source = own) не трогаются. Условия — в самой
-- команде: одновременный вход с пересчётом и эта замена друг друга не затирают.
SET LOCAL application_name = 'osp:auth';
WITH ins AS (
  INSERT INTO osp_auth.credentials (user_id, secret, algo, source, supabase_sha256)
  SELECT c.user_id, c.secret, 'bcrypt', 'supabase', c.supabase_sha256 FROM in_cred c
  WHERE c.user_id IN (SELECT id FROM t_users) AND c.user_id NOT IN (SELECT user_id FROM t_cred)
  ON CONFLICT (user_id) DO NOTHING
  RETURNING 1)
INSERT INTO rep SELECT 'passwords_new', count(*) FROM ins;
WITH upd AS (
  UPDATE osp_auth.credentials k SET secret = c.secret, algo = 'bcrypt', version = k.version + 1,
         supabase_sha256 = c.supabase_sha256, changed_at = now()
  FROM in_cred c
  WHERE k.user_id = c.user_id AND k.source = 'supabase' AND k.supabase_sha256 IS DISTINCT FROM c.supabase_sha256
  RETURNING k.user_id)
INSERT INTO t_changed SELECT user_id FROM upd;
INSERT INTO rep SELECT 'passwords_changed_in_supabase', count(*) FROM t_changed;
INSERT INTO rep SELECT 'passwords_kept_changed_here', count(*) FROM in_cred c JOIN t_cred t USING (user_id)
  WHERE t.source = 'own' AND t.supabase_sha256 IS DISTINCT FROM c.supabase_sha256;
INSERT INTO rep SELECT 'accounts_without_password', count(*) FROM t_users u
  WHERE NOT EXISTS (SELECT 1 FROM osp_auth.credentials k WHERE k.user_id = u.id);
INSERT INTO osp_auth.events (user_id, kind, detail) SELECT user_id, 'password_synced', '{}'::jsonb FROM t_changed;
INSERT INTO osp_auth.meta (key, value) VALUES ('canary', :'canary') ON CONFLICT (key) DO NOTHING;
INSERT INTO osp_auth.meta (key, value, updated_at)
  VALUES ('accounts_sync', json_build_object('fingerprint', :'fingerprint', 'users_sha256', :'users_sha')::text, now())
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now();

-- Пароль изменили в Supabase после прошлой копии — сессии со старым паролем в новом портале отзываются.
SET LOCAL application_name = 'osp:internal';
WITH r AS (
  UPDATE osp_session.sessions SET revoked_at = now(), revoke_reason = 'password_synced'
  WHERE user_id IN (SELECT user_id FROM t_changed) AND revoked_at IS NULL RETURNING 1)
INSERT INTO rep SELECT 'sessions_revoked', count(*) FROM r;

SELECT 'OSP_SYNC ' || k || '=' || n FROM rep ORDER BY k;
\if :commit
COMMIT;
\echo OSP_SYNC_COMMITTED
\else
ROLLBACK;
\echo OSP_SYNC_DRY_RUN
\endif
