-- АВАРИЙНЫЙ ОТКАТ 20270120_object_scope_files (только база Яндекса): правила договоров, привязанных к ним таблиц и строк файлов
-- возвращаются к прежнему тексту (копия — osp_private.policy_backup_20270120), охват заявок и ПСДЦ — прежним правилом
-- (пустой список объектов — все), снимаются триггеры строк файлов и настроек, функция своего профиля.
-- Данные НЕ удаляются: roles.object_scoped, учёт загрузок и копия правил остаются (повторное применение миграции пропустит
-- уже изменённые правила — поэтому копия после отката очищается). Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL application_name = 'osp:internal';

DO $restore$
DECLARE
  b record;
  v_cmd text;
  v_sql text;
BEGIN
  FOR b IN SELECT * FROM osp_private.policy_backup_20270120 ORDER BY table_name, policy_name LOOP
    SELECT p.cmd INTO v_cmd FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = b.table_name AND p.policyname = b.policy_name;
    IF NOT FOUND THEN CONTINUE; END IF;
    v_sql := format('ALTER POLICY %I ON public.%I', b.policy_name, b.table_name);
    IF b.qual IS NOT NULL THEN v_sql := v_sql || format(' USING (%s)', b.qual); END IF;
    IF b.with_check IS NOT NULL THEN v_sql := v_sql || format(' WITH CHECK (%s)', b.with_check); END IF;
    IF b.qual IS NOT NULL OR b.with_check IS NOT NULL THEN EXECUTE v_sql; END IF;
  END LOOP;
  DELETE FROM osp_private.policy_backup_20270120;
END
$restore$;

DROP TRIGGER IF EXISTS s3_documents_user_guard ON public.s3_documents;
DROP FUNCTION IF EXISTS public.s3_documents_user_guard();
DROP TRIGGER IF EXISTS app_settings_write_guard ON public.app_settings;
DROP FUNCTION IF EXISTS public.app_settings_write_guard();
DROP FUNCTION IF EXISTS public.app_settings_key_sections(text);
DROP FUNCTION IF EXISTS public.profile_update_own(text, text, text);

CREATE OR REPLACE FUNCTION public.dp_request_scope() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT CASE WHEN public.is_admin() THEN NULL
              ELSE (SELECT nullif(ur.object_ids, '{}'::uuid[]) FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1) END
$$;

CREATE OR REPLACE FUNCTION public.doc_check_scope() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT CASE WHEN public.is_admin() THEN NULL
              ELSE (SELECT nullif(ur.object_ids, '{}'::uuid[]) FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1) END
$$;

CREATE OR REPLACE FUNCTION public.psdc_object_in_scope(p_object_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT public.is_admin() OR COALESCE((
    SELECT CASE
      WHEN jsonb_typeof(to_jsonb(ur) -> 'object_ids') = 'array'
           AND jsonb_array_length(to_jsonb(ur) -> 'object_ids') > 0
        THEN p_object_id IS NOT NULL AND (to_jsonb(ur) -> 'object_ids') ? p_object_id::text
      WHEN (to_jsonb(ur) ->> 'object_id') IS NOT NULL
        THEN p_object_id IS NOT NULL AND p_object_id::text = to_jsonb(ur) ->> 'object_id'
      ELSE true
    END
    FROM user_roles ur
    WHERE ur.user_id = auth.uid()
    LIMIT 1
  ), false);
$$;

DROP FUNCTION IF EXISTS public.osp_contract_in_scope(uuid);
DROP FUNCTION IF EXISTS public.osp_object_scope();

COMMIT;
