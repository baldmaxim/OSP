-- Охват по объектам для договоров, чтение и неизменность строк файлов, учёт загрузок, настройки разделов, свой профиль
-- (только база Яндекса).
--
-- 1. Охват по объектам — одно правило для всех разделов: public.osp_object_scope() → массив объектов или NULL (все).
--      администратор → NULL; непустой user_roles.object_ids → он; иначе прежний object_id → [он]; иначе роль «по объектам»
--      (roles.object_scoped: руководитель строительства, экономист объекта) → '{}' (ни одного: ошибка назначения не открывает
--      всё); иначе NULL. Тем же правилом теперь считают dp_request_scope(), doc_check_scope(), psdc_object_in_scope().
-- 2. Договоры и всё, что к ним привязано (дочерние таблицы, пункты и споры согласования, вложения объекта), — только
--    своих объектов: к каждому правилу таблицы (USING и WITH CHECK) дописано условие охвата. ДС нельзя привязать к договору
--    чужого объекта, строку — перенести в чужой объект. Подрядчика не задевает: у него охват NULL. Прежний текст правил —
--    в osp_private.policy_backup_20270120 (откат возвращает его). Ограничивающие (RESTRICTIVE) правила в режиме одной учётки
--    не поддерживаются (load-single-owner.sql), поэтому условие встроено в существующие.
-- 3. Строки файлов (s3_documents): сотрудник видит файл, только если видит его владельца — право раздела (просмотр или
--    правка) и охват договора; файл задачи — по видимости задачи, заявок — по видимости заявки. Менять у строки можно только
--    имя и описание (триггер — список разрешённого: новые колонки закрыты сами); автора загрузки ставит сервер.
-- 4. Незавершённые загрузки: osp_private.s3_upload_intents (пишет и убирает служба, src/lib/uploadIntents.js).
-- 5. Настройки разделов (app_settings): ключ пишет тот, у кого правка его раздела; незнакомый ключ — администратор.
-- 6. Свой профиль: profile_update_own — ФИО, телефон, почта своей строки user_roles (прямая правка user_roles — администратору).

-- ── 1. Охват по объектам ─────────────────────────────────────────────────────
ALTER TABLE public.roles ADD COLUMN IF NOT EXISTS object_scoped boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.roles.object_scoped IS 'Роль работает по своим объектам (user_roles.object_ids): без назначенных объектов — ни одного';
UPDATE public.roles SET object_scoped = true WHERE key IN ('construction_manager', 'economist_object') AND object_scoped IS DISTINCT FROM true;

CREATE OR REPLACE FUNCTION public.osp_object_scope() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT CASE WHEN public.is_admin() THEN NULL ELSE (
    SELECT CASE
             WHEN cardinality(coalesce(ur.object_ids, '{}'::uuid[])) > 0 THEN ur.object_ids
             WHEN (to_jsonb(ur) ->> 'object_id') IS NOT NULL THEN ARRAY[(to_jsonb(ur) ->> 'object_id')::uuid]
             WHEN coalesce(r.object_scoped, false) THEN '{}'::uuid[]
             ELSE NULL
           END
    FROM public.user_roles ur
    LEFT JOIN public.roles r ON r.key = ur.role
    WHERE ur.user_id = auth.uid()
    LIMIT 1) END
$$;

CREATE OR REPLACE FUNCTION public.dp_request_scope() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$ SELECT public.osp_object_scope() $$;

CREATE OR REPLACE FUNCTION public.doc_check_scope() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$ SELECT public.osp_object_scope() $$;

CREATE OR REPLACE FUNCTION public.psdc_object_in_scope(p_object_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT s IS NULL OR (p_object_id IS NOT NULL AND p_object_id = ANY (s)) FROM (SELECT public.osp_object_scope() AS s) x
$$;

-- Договор в охвате вошедшего (с пропуском: смотрит сам договор, а не правила по его строкам). Охват NULL — да.
CREATE OR REPLACE FUNCTION public.osp_contract_in_scope(p_contract uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT CASE WHEN x.s IS NULL THEN true
              ELSE EXISTS (SELECT 1 FROM public.contracts c WHERE c.id = p_contract AND c.object_id = ANY (x.s)) END
  FROM (SELECT public.osp_object_scope() AS s) x
$$;

-- ── 2. Договоры и привязанное к ним ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS osp_private.policy_backup_20270120 (
  table_name text NOT NULL,
  policy_name text NOT NULL,
  qual text,
  with_check text,
  PRIMARY KEY (table_name, policy_name)
);
ALTER TABLE osp_private.policy_backup_20270120 ENABLE ROW LEVEL SECURITY;
ALTER TABLE osp_private.policy_backup_20270120 FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osp_internal ON osp_private.policy_backup_20270120;
CREATE POLICY osp_internal ON osp_private.policy_backup_20270120 FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

DO $scope$
DECLARE
  by_contract constant text := '(SELECT public.osp_object_scope()) IS NULL OR public.osp_contract_in_scope(contract_id)';
  by_dispute constant text := '(SELECT public.osp_object_scope()) IS NULL OR EXISTS (SELECT 1 FROM public.contract_clause_disputes d WHERE d.id = dispute_id)';
  by_object constant text := '(SELECT public.osp_object_scope()) IS NULL OR object_id = ANY ((SELECT public.osp_object_scope()))';
  conds jsonb := jsonb_build_object(
    'contracts', jsonb_build_array(by_object,
      '(' || by_object || ') AND (parent_contract_id IS NULL OR public.osp_contract_in_scope(parent_contract_id))'
      || ' AND (root_contract_id IS NULL OR root_contract_id = id OR public.osp_contract_in_scope(root_contract_id))'),
    'object_contract_attachments', jsonb_build_array(by_object, by_object),
    'contract_advance_schedule', jsonb_build_array(by_contract, by_contract),
    'contract_appendices', jsonb_build_array(by_contract, by_contract),
    'contract_attachments', jsonb_build_array(by_contract, by_contract),
    'contract_audit_log', jsonb_build_array(by_contract, by_contract),
    'contract_clause_disputes', jsonb_build_array(by_contract, by_contract),
    'contract_clauses', jsonb_build_array(by_contract, by_contract),
    'contract_counterparties', jsonb_build_array(by_contract, by_contract),
    'contract_psdc_items', jsonb_build_array(by_contract, by_contract),
    'counterparty_contract_links', jsonb_build_array(by_contract, by_contract),
    'contract_clause_comments', jsonb_build_array(by_dispute, by_dispute),
    'contract_clause_dispute_clauses', jsonb_build_array(by_dispute, by_dispute));
  r record;
  v_roles text[];
  v_using text;
  v_check text;
  v_sql text;
BEGIN
  FOR r IN
    SELECT p.tablename, p.policyname, p.cmd, p.qual, p.with_check
    FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.policyname <> 'osp_internal' AND conds ? p.tablename
      AND NOT EXISTS (SELECT 1 FROM osp_private.policy_backup_20270120 b
                      WHERE b.table_name = p.tablename AND b.policy_name = p.policyname)
    ORDER BY p.tablename, p.policyname
  LOOP
    SELECT pr.roles INTO v_roles FROM osp_meta.policy_roles pr
     WHERE pr.schema_name = 'public' AND pr.table_name = r.tablename AND pr.policy_name = r.policyname;
    IF v_roles IS NULL THEN RAISE EXCEPTION 'нет записи о ролях правила %.%', r.tablename, r.policyname; END IF;
    INSERT INTO osp_private.policy_backup_20270120 VALUES (r.tablename, r.policyname, r.qual, r.with_check);
    v_using := conds -> r.tablename ->> 0;
    v_check := conds -> r.tablename ->> 1;
    v_sql := format('ALTER POLICY %I ON public.%I', r.policyname, r.tablename);
    IF r.qual IS NOT NULL THEN
      v_sql := v_sql || format(' USING (CASE WHEN (SELECT osp_private.bypass()) THEN true ELSE ((SELECT osp_private.role_in(VARIADIC %L::text[])) AND (%s) AND (%s)) END)',
                               v_roles, r.qual, v_using);
    END IF;
    IF r.with_check IS NOT NULL THEN
      v_sql := v_sql || format(' WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true ELSE ((SELECT osp_private.role_in(VARIADIC %L::text[])) AND (%s) AND (%s)) END)',
                               v_roles, r.with_check, v_check);
    END IF;
    EXECUTE v_sql;
  END LOOP;
END
$scope$;

-- ── 3. Файлы ─────────────────────────────────────────────────────────────────
-- Чтение строки файла сотрудником: видит владельца. Только USING правила сотрудника (вставку держат права osp-api и триггеры
-- заявок); правило подрядчика не меняется.
DO $s3_read$
DECLARE
  r record;
  v_roles text[];
  owner_read constant text := $cond$CASE owner_type
    WHEN 'contract' THEN ((SELECT public.osp_can('contracts', 'view')) OR (SELECT public.osp_can('contracts', 'edit')))
                         AND ((SELECT public.osp_object_scope()) IS NULL OR public.osp_contract_in_scope(owner_id))
    WHEN 'tender' THEN (SELECT public.osp_can('tenders', 'view')) OR (SELECT public.osp_can('tenders', 'edit'))
                       OR (SELECT public.osp_can('tenders_materials', 'view')) OR (SELECT public.osp_can('tenders_materials', 'edit'))
                       OR (SELECT public.osp_can('vors', 'view')) OR (SELECT public.osp_can('vors', 'edit'))
    WHEN 'dc_request' THEN (SELECT public.osp_can('dc_requests', 'view')) OR (SELECT public.osp_can('dc_requests', 'edit'))
    WHEN 'counterparty' THEN (SELECT public.osp_can('counterparties', 'view')) OR (SELECT public.osp_can('counterparties', 'edit'))
    WHEN 'general_document' THEN (SELECT public.osp_can('general_documents', 'view')) OR (SELECT public.osp_can('general_documents', 'edit'))
    WHEN 'task' THEN public.can_see_task(owner_id)
    WHEN 'dp_request' THEN EXISTS (SELECT 1 FROM public.dp_requests q WHERE q.id = owner_id)
    WHEN 'doc_check_request' THEN EXISTS (SELECT 1 FROM public.doc_check_requests q WHERE q.id = owner_id)
    WHEN 'general' THEN CASE doc_category
      WHEN 'psdc_source' THEN (SELECT public.osp_can('contracts', 'view')) OR (SELECT public.osp_can('contracts', 'edit'))
      WHEN 'kp_manual_rate' THEN (SELECT public.osp_can('rates_registry', 'view')) OR (SELECT public.osp_can('rates_registry', 'edit'))
      ELSE true END
    ELSE true
  END$cond$;
BEGIN
  SELECT p.policyname, p.qual INTO r FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 's3_documents' AND p.policyname = 'portal_employee_all';
  IF NOT FOUND THEN RAISE EXCEPTION 's3_documents: нет правила portal_employee_all'; END IF;
  IF NOT EXISTS (SELECT 1 FROM osp_private.policy_backup_20270120 b WHERE b.table_name = 's3_documents' AND b.policy_name = 'portal_employee_all') THEN
    SELECT pr.roles INTO v_roles FROM osp_meta.policy_roles pr
     WHERE pr.schema_name = 'public' AND pr.table_name = 's3_documents' AND pr.policy_name = 'portal_employee_all';
    IF v_roles IS NULL THEN RAISE EXCEPTION 'нет записи о ролях правила s3_documents.portal_employee_all'; END IF;
    INSERT INTO osp_private.policy_backup_20270120 (table_name, policy_name, qual, with_check)
    SELECT 's3_documents', 'portal_employee_all', p.qual, p.with_check FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = 's3_documents' AND p.policyname = 'portal_employee_all';
    EXECUTE format('ALTER POLICY portal_employee_all ON public.s3_documents USING (CASE WHEN (SELECT osp_private.bypass()) THEN true ELSE ((SELECT osp_private.role_in(VARIADIC %L::text[])) AND (%s) AND (%s)) END)',
                   v_roles, r.qual, owner_read);
  END IF;
END
$s3_read$;

-- Строка файла: менять можно только имя и описание; автора загрузки ставит сервер. Служебные операции — как раньше.
CREATE OR REPLACE FUNCTION public.s3_documents_user_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  a record;
  v_free constant text[] := ARRAY['file_name', 'notes', 'updated_at'];
BEGIN
  IF auth.uid() IS NULL OR (SELECT osp_private.bypass()) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO a FROM public.psdc_actor();
    NEW.uploaded_by := auth.uid();
    NEW.uploaded_by_name := coalesce(nullif(btrim(a.full_name), ''), nullif(auth.email(), ''));
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free) THEN
    RAISE EXCEPTION 'У файла можно изменить только имя и описание' USING ERRCODE = '42501', HINT = 's3_document_immutable';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS s3_documents_user_guard ON public.s3_documents;
CREATE TRIGGER s3_documents_user_guard BEFORE INSERT OR UPDATE ON public.s3_documents
  FOR EACH ROW EXECUTE FUNCTION public.s3_documents_user_guard();

-- ── 4. Незавершённые загрузки ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS osp_private.s3_upload_intents (
  s3_key text PRIMARY KEY CHECK (char_length(s3_key) BETWEEN 1 AND 1200),
  user_id uuid NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS s3_upload_intents_user_idx ON osp_private.s3_upload_intents (user_id, created_at);
CREATE INDEX IF NOT EXISTS s3_upload_intents_created_idx ON osp_private.s3_upload_intents (created_at);
COMMENT ON TABLE osp_private.s3_upload_intents IS 'Выданные ссылки на загрузку файла без подтверждения: предел на пользователя и уборка объектов через час';
ALTER TABLE osp_private.s3_upload_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE osp_private.s3_upload_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osp_internal ON osp_private.s3_upload_intents;
CREATE POLICY osp_internal ON osp_private.s3_upload_intents FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- ── 5. Настройки разделов ────────────────────────────────────────────────────
-- @APP_SETTINGS@

-- ── 6. Свой профиль ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.profile_update_own(p_full_name text DEFAULT NULL, p_work_phone text DEFAULT NULL,
                                                    p_work_email text DEFAULT NULL) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Нужен вход' USING ERRCODE = '42501'; END IF;
  IF char_length(coalesce(p_full_name, '')) > 200 OR char_length(coalesce(p_work_phone, '')) > 60
     OR char_length(coalesce(p_work_email, '')) > 200 THEN
    RAISE EXCEPTION 'Слишком длинное значение' USING ERRCODE = '22001';
  END IF;
  -- NULL — поле не меняется; пустая строка — очистить.
  UPDATE public.user_roles SET
    full_name = CASE WHEN p_full_name IS NULL THEN full_name ELSE nullif(btrim(p_full_name), '') END,
    work_phone = CASE WHEN p_work_phone IS NULL THEN work_phone ELSE nullif(btrim(p_work_phone), '') END,
    work_email = CASE WHEN p_work_email IS NULL THEN work_email ELSE nullif(btrim(p_work_email), '') END
  WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Нет учётной записи портала' USING ERRCODE = '42501'; END IF;
END
$$;
-- osp:allow rpc profile_update_own authenticated
