-- Р2a + Р2b: одно правило «сотрудника» на сервере; таблицы сотрудников — только сотрудникам.
--
-- ПРОБЛЕМА (инвентаризация 2026-10-08, test:db). 43 политики «USING (true)» пускали к данным
-- сотрудников любого вошедшего: неодобренного, заблокированного, подрядчика, учётку без роли.
-- Суперадмин задан адресом почты в коде функций. При саморегистрации можно было вписать себе
-- организацию, объекты и снять блокировку.
--
-- РЕШЕНИЕ.
--  • superadmins — таблица вместо адреса почты (заполняется здесь из auth.users).
--  • osp_is_employee() — одно правило: администратор или одобрен, не заблокирован, без организации,
--    роль не «contractor». is_portal_employee / is_negotiation_employee / vor_requests_can_access
--    получают то же тело (без вложенных вызовов: старые политики зовут их на каждую строку);
--    current_counterparty_id учитывает блокировку.
--  • osp_can(section, kind) — права раздела на сервере; используется с Р2c.
--  • 43 широкие политики → (SELECT osp_is_employee()) — функция считается раз на запрос.
--    Подрядческие политики objects и counterparties остаются и начинают действовать.
--  • rd_doc_codes_write — только сотрудник; саморегистрация — без организации, объектов и блокировки.
--
-- Сотрудники ничего не теряют (test:db: у классов сотрудников изменений 0). Данные не меняются,
-- кроме одной строки в новой superadmins. Повтор безопасен. Аварийный откат —
-- migration/rollback/20261010_r2ab_rollback.sql. Всё — одной транзакцией.
BEGIN;

-- 1. Суперадмин — таблица вместо адреса почты в коде.
CREATE TABLE IF NOT EXISTS public.superadmins (
  user_id  uuid PRIMARY KEY,
  added_at timestamptz NOT NULL DEFAULT now(),
  note     text
);
ALTER TABLE public.superadmins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.superadmins FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.superadmins IS
  'Суперадминистраторы портала. Пишут только миграции и service_role; политик нет — клиенту недоступна.';
INSERT INTO public.superadmins (user_id, note)
SELECT u.id, 'перенесён из адреса в коде (миграция 20261010)'
FROM auth.users u
WHERE lower(u.email) = 'sadovnikov.d.y@su10.ru'
ON CONFLICT (user_id) DO NOTHING;

-- 2. Правила.
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.is_approved = true
  )
  OR EXISTS (SELECT 1 FROM public.superadmins s WHERE s.user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.osp_is_employee() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.is_approved = true
      AND (ur.role = 'admin'
           OR (ur.is_blocked = false AND ur.counterparty_id IS NULL AND ur.role <> 'contractor'))
  )
  OR EXISTS (SELECT 1 FROM public.superadmins s WHERE s.user_id = auth.uid());
$$;
COMMENT ON FUNCTION public.osp_is_employee() IS
  'Сотрудник портала: администратор или одобрен, не заблокирован, без организации, роль не contractor. Единое правило для политик (Р2).';

CREATE OR REPLACE FUNCTION public.osp_counterparty_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT ur.counterparty_id
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid() AND ur.is_approved = true AND ur.is_blocked = false
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.osp_can(p_section text, p_kind text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT public.is_admin() OR EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role = ur.role AND rp.section = p_section
    WHERE ur.user_id = auth.uid()
      AND ur.is_approved = true
      AND ur.is_blocked = false
      AND ur.counterparty_id IS NULL
      AND ur.role <> 'contractor'
      AND CASE WHEN p_kind = 'edit' THEN rp.can_edit ELSE rp.can_view END
  );
$$;
COMMENT ON FUNCTION public.osp_can(text, text) IS
  'Право раздела на сервере (как canView/canEdit в RoleContext): p_kind = ''view'' | ''edit''. Для Р2c.';

REVOKE ALL ON FUNCTION public.osp_is_employee() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.osp_counterparty_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.osp_can(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.osp_is_employee() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.osp_counterparty_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.osp_can(text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_portal_employee() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.is_approved = true
      AND (ur.role = 'admin'
           OR (ur.is_blocked = false AND ur.counterparty_id IS NULL AND ur.role <> 'contractor'))
  )
  OR EXISTS (SELECT 1 FROM public.superadmins s WHERE s.user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.is_negotiation_employee() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.is_approved = true
      AND (ur.role = 'admin'
           OR (ur.is_blocked = false AND ur.counterparty_id IS NULL AND ur.role <> 'contractor'))
  )
  OR EXISTS (SELECT 1 FROM public.superadmins s WHERE s.user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.current_counterparty_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT ur.counterparty_id
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid() AND ur.is_approved = true AND ur.is_blocked = false
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.vor_requests_can_access() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.is_approved = true
      AND (ur.role = 'admin'
           OR (ur.is_blocked = false AND ur.counterparty_id IS NULL AND ur.role <> 'contractor'))
  )
  OR EXISTS (SELECT 1 FROM public.superadmins s WHERE s.user_id = auth.uid());
$$;
CREATE OR REPLACE FUNCTION public.get_auth_users() RETURNS TABLE(id uuid, email text, created_at timestamp with time zone, last_sign_in_at timestamp with time zone, email_confirmed_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth', 'pg_temp'
    AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Недостаточно прав: список пользователей доступен только администратору'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT au.id, au.email::TEXT, au.created_at, au.last_sign_in_at, au.email_confirmed_at
  FROM auth.users au
  ORDER BY au.created_at ASC;
END;
$$;
CREATE OR REPLACE FUNCTION public.admin_confirm_user_email(target_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth', 'pg_temp'
    AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Недостаточно прав: подтверждать почту может только администратор'
      USING ERRCODE = '42501';
  END IF;

  UPDATE auth.users
  SET email_confirmed_at = now()
  WHERE id = target_user_id AND email_confirmed_at IS NULL;
END;
$$;
-- 3. Широкие политики «USING (true)» → только сотрудник (43).
ALTER POLICY "Allow all for authenticated" ON public.bsm_supply_rates
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.app_settings
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.bsm_contract_rates
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.bsm_contractor_rates
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.contract_appendices
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.contract_attachments
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.contract_audit_log
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.counterparty_audit_log
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.counterparty_relations
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.dc_request_audit_log
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.departments
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.document_check_requests
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.employees
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.general_document_folders
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.general_document_links
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.general_documents
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.object_areas
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.object_contract_attachments
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.object_staff
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.object_warranties
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.object_warranty_retention_payments
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.object_warranty_retentions
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.positions
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.tender_audit_log
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.tender_doc_links
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.tender_docs
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.tender_rd_codes
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.tender_vor_supply_rates
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.tender_winners
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users" ON public.work_types
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users on contract_advance_schedule" ON public.contract_advance_schedule
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users on contract_psdc_items" ON public.contract_psdc_items
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users on object_cost_plan" ON public.object_cost_plan
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Allow all for authenticated users on object_documents" ON public.object_documents
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Enable all for dc_request_tasks" ON public.dc_request_tasks
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Enable all for dc_requests" ON public.dc_requests
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY "Enable all for tender_proposal_files" ON public.tender_proposal_files
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY rls_authenticated_all ON public.contacts
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY rls_authenticated_all ON public.counterparties
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY rls_authenticated_all ON public.counterparty_contacts
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY rls_authenticated_all ON public.object_estimate_items
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY rls_authenticated_all ON public.objects
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));
ALTER POLICY rls_authenticated_all ON public.tender_documents
  USING ((SELECT public.osp_is_employee())) WITH CHECK ((SELECT public.osp_is_employee()));

-- 4. Коды РД у документов: писать может только сотрудник (было: «роль не contractor», без одобрения).
ALTER POLICY rd_doc_codes_write ON public.tender_rd_document_codes
  USING ((SELECT public.osp_is_employee()))
  WITH CHECK ((SELECT public.osp_is_employee()) AND EXISTS (
    SELECT 1
    FROM public.s3_documents d
    JOIN public.tender_rd_codes c ON c.tender_id = d.owner_id
    WHERE d.id = tender_rd_document_codes.document_id
      AND c.id = tender_rd_document_codes.rd_code_id
      AND d.owner_type = 'tender'));

-- 5. Саморегистрация: только своя строка, не одобрена, без организации, объектов и блокировки.
ALTER POLICY user_roles_insert_self_pending ON public.user_roles
  WITH CHECK (user_id = auth.uid()
              AND is_approved = false
              AND role = ANY (ARRAY['contractor'::text, 'engineer'::text])
              AND counterparty_id IS NULL
              AND object_id IS NULL
              AND object_ids = '{}'::uuid[]
              AND is_blocked = false);

COMMIT;
