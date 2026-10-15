-- Готовность своего входа (accounts-check.sh; её же выполняет deploy-server.sh auth-mode own прямо перед
-- переключением). Только чтение. Строки «OK …» / «FAIL …» и «INFO …»; хоть один FAIL — свой вход не включается.
--   • схемы своего входа есть, канарейка ключа на месте (её расшифровку проверяет /api/ready службы);
--   • каждый пользователь портала (user_roles) и каждый id в колонках-владельцах (migration/inventory.md, §3)
--     есть в auth.users — иначе после переключения его записи «ничьи»;
--   • у одобренных пользователей есть пароли (без пароля войти нельзя — нужен временный от администратора);
--   • отпечаток последнего переноса (сверить с описью свежей выгрузки) и состояние паролей сейчас.
-- Отметки меняются внутри одного блока: учётки — osp:internal, пароли — osp:auth.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SET LOCAL application_name = 'osp:internal';
DO $check$
DECLARE
  r record;
  n bigint;
  v_dangling text := '';
  v_approved uuid[];
  v_all uuid[];
BEGIN
  IF to_regnamespace('osp_auth') IS NULL OR to_regnamespace('osp_session') IS NULL THEN
    PERFORM set_config('osp_check.schemas', 'no', true);
    RETURN;
  END IF;
  PERFORM set_config('osp_check.schemas', 'yes', true);
  FOR r IN SELECT * FROM (VALUES
      ('user_roles', 'user_id'), ('s3_documents', 'uploaded_by'),
      ('general_documents', 'created_by'), ('general_documents', 'updated_by'),
      ('general_document_folders', 'created_by'), ('general_document_folders', 'updated_by'),
      ('tender_docs', 'created_by'), ('tender_docs', 'updated_by'),
      ('tasks', 'created_by_user_id'), ('tasks', 'assignee_user_id'), ('task_participants', 'user_id'),
      ('task_comments', 'author_user_id'), ('tenders', 'vor_sto_user_id'), ('tenders', 'materials_resp_user_id'),
      ('vor_requests', 'created_by'), ('vor_requests', 'vor_sto_user_id'),
      ('psdc', 'uploaded_by'), ('psdc', 'applied_by'), ('psdc_batches', 'created_by')) AS o(t, c)
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = r.t AND column_name = r.c) THEN
      EXECUTE format('SELECT count(DISTINCT x.%I) FROM public.%I x WHERE x.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = x.%I::uuid)',
        r.c, r.t, r.c, r.c) INTO n;
      IF n > 0 THEN v_dangling := v_dangling || format(' %s.%s=%s', r.t, r.c, n); END IF;
    END IF;
  END LOOP;
  PERFORM set_config('osp_check.dangling', v_dangling, true);
  PERFORM set_config('osp_check.users', (SELECT count(*) FROM auth.users)::text, true);
  SELECT array_agg(user_id) INTO v_approved FROM public.user_roles WHERE is_approved AND NOT is_blocked;
  SELECT array_agg(id) INTO v_all FROM auth.users;

  PERFORM set_config('application_name', 'osp:auth', true);
  PERFORM set_config('osp_check.canary', (EXISTS (SELECT 1 FROM osp_auth.meta WHERE key = 'canary'))::text, true);
  PERFORM set_config('osp_check.approved_nopass', (SELECT count(*) FROM unnest(coalesce(v_approved, '{}')) a(id)
    WHERE NOT EXISTS (SELECT 1 FROM osp_auth.credentials k WHERE k.user_id = a.id))::text, true);
  PERFORM set_config('osp_check.all_nopass', (SELECT count(*) FROM unnest(coalesce(v_all, '{}')) a(id)
    WHERE NOT EXISTS (SELECT 1 FROM osp_auth.credentials k WHERE k.user_id = a.id))::text, true);
  PERFORM set_config('osp_check.stats', (SELECT 'из Supabase — ' || count(*) FILTER (WHERE source = 'supabase') || ', свои — '
    || count(*) FILTER (WHERE source = 'own') || '; ключи: ' || coalesce(string_agg(DISTINCT split_part(secret, ':', 2), ','), '—')
    FROM osp_auth.credentials), true);
  PERFORM set_config('osp_check.last_sync', coalesce((SELECT value || ' в ' || to_char(updated_at, 'YYYY-MM-DD HH24:MI')
    FROM osp_auth.meta WHERE key = 'accounts_sync'), 'не выполнялся'), true);
  PERFORM set_config('osp_check.state', (SELECT md5(coalesce(string_agg(user_id::text || ':' || version, ',' ORDER BY user_id), ''))
    FROM osp_auth.credentials), true);
  PERFORM set_config('application_name', 'osp:internal', true);
END
$check$;
SELECT CASE WHEN current_setting('osp_check.schemas') = 'yes' THEN 'OK ' ELSE 'FAIL ' END
       || 'схемы своего входа на месте (миграция 20261019_own_auth)';
SELECT current_setting('osp_check.schemas') = 'yes' AS osp_schemas \gset
\if :osp_schemas
SELECT CASE WHEN current_setting('osp_check.dangling') = '' THEN 'OK ' ELSE 'FAIL ' END
       || 'каждый пользователь портала и каждый владелец записей есть в auth.users'
       || CASE WHEN current_setting('osp_check.dangling') = '' THEN ': ' || current_setting('osp_check.users') || ' учёток'
               ELSE ' — НЕТ УЧЁТОК ДЛЯ:' || current_setting('osp_check.dangling') END;
SELECT CASE WHEN current_setting('osp_check.canary') = 'true' THEN 'OK ' ELSE 'FAIL ' END
       || 'канарейка ключа сервера записана (перенос учёток выполнялся)';
SELECT CASE WHEN current_setting('osp_check.approved_nopass') = '0' THEN 'OK ' ELSE 'FAIL ' END
       || 'у одобренных пользователей есть пароли'
       || CASE WHEN current_setting('osp_check.approved_nopass') = '0' THEN ''
               ELSE ': без пароля — ' || current_setting('osp_check.approved_nopass') || ' (временный пароль от администратора)' END;
SELECT 'INFO учёток без пароля всего: ' || current_setting('osp_check.all_nopass');
SELECT 'INFO паролей: ' || current_setting('osp_check.stats');
SELECT 'INFO последний перенос: ' || current_setting('osp_check.last_sync');
SELECT 'INFO состояние паролей: ' || current_setting('osp_check.state');
\endif
ROLLBACK;
