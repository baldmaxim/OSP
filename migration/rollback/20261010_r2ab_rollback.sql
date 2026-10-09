-- АВАРИЙНЫЙ ОТКАТ миграции 20261010_r2ab_employee_only.sql — только с разрешения владельца системы.
-- Возвращает прежние политики (USING (true)), исходные тела функций и правило саморегистрации.
-- Таблицу superadmins и функции osp_* не удаляет (данные не трогаем; они безвредны).
-- Проверен на копии прода (test:db: миграция + откат = исходный эталон). Одной транзакцией.
BEGIN;

ALTER POLICY "Allow all for authenticated" ON public.bsm_supply_rates USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.app_settings USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.bsm_contract_rates USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.bsm_contractor_rates USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.contract_appendices USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.contract_attachments USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.contract_audit_log USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.counterparty_audit_log USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.counterparty_relations USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.dc_request_audit_log USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.departments USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.document_check_requests USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.employees USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.general_document_folders USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.general_document_links USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.general_documents USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.object_areas USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.object_contract_attachments USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.object_staff USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.object_warranties USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.object_warranty_retention_payments USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.object_warranty_retentions USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.positions USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.tender_audit_log USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.tender_doc_links USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.tender_docs USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.tender_rd_codes USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.tender_vor_supply_rates USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.tender_winners USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users" ON public.work_types USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users on contract_advance_schedule" ON public.contract_advance_schedule USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users on contract_psdc_items" ON public.contract_psdc_items USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users on object_cost_plan" ON public.object_cost_plan USING (true) WITH CHECK (true);
ALTER POLICY "Allow all for authenticated users on object_documents" ON public.object_documents USING (true) WITH CHECK (true);
ALTER POLICY "Enable all for dc_request_tasks" ON public.dc_request_tasks USING (true) WITH CHECK (true);
ALTER POLICY "Enable all for dc_requests" ON public.dc_requests USING (true) WITH CHECK (true);
ALTER POLICY "Enable all for tender_proposal_files" ON public.tender_proposal_files USING (true) WITH CHECK (true);
ALTER POLICY rls_authenticated_all ON public.contacts USING (true) WITH CHECK (true);
ALTER POLICY rls_authenticated_all ON public.counterparties USING (true) WITH CHECK (true);
ALTER POLICY rls_authenticated_all ON public.counterparty_contacts USING (true) WITH CHECK (true);
ALTER POLICY rls_authenticated_all ON public.object_estimate_items USING (true) WITH CHECK (true);
ALTER POLICY rls_authenticated_all ON public.objects USING (true) WITH CHECK (true);
ALTER POLICY rls_authenticated_all ON public.tender_documents USING (true) WITH CHECK (true);

ALTER POLICY rd_doc_codes_write ON public.tender_rd_document_codes
  USING ((NOT (EXISTS ( SELECT 1
   FROM public.user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.role = 'contractor'::text))))))
  WITH CHECK (((NOT (EXISTS ( SELECT 1
   FROM public.user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.role = 'contractor'::text))))) AND (EXISTS ( SELECT 1
   FROM (public.s3_documents d
     JOIN public.tender_rd_codes c ON ((c.tender_id = d.owner_id)))
  WHERE ((d.id = tender_rd_document_codes.document_id) AND (c.id = tender_rd_document_codes.rd_code_id) AND (d.owner_type = 'tender'::text))))));

ALTER POLICY user_roles_insert_self_pending ON public.user_roles
  WITH CHECK (((user_id = auth.uid()) AND (is_approved = false) AND (role = ANY (ARRAY['contractor'::text, 'engineer'::text]))));

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.is_approved = true
  )
  OR EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = auth.uid() AND lower(u.email) = 'sadovnikov.d.y@su10.ru'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_portal_employee() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.is_approved = true
      AND ur.counterparty_id IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.is_negotiation_employee() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.is_approved = true
      AND ur.counterparty_id IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.current_counterparty_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT ur.counterparty_id
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid() AND ur.is_approved = true
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.vor_requests_can_access() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.is_approved = true AND ur.role <> 'contractor'
  )
  OR EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = auth.uid() AND lower(u.email) = 'sadovnikov.d.y@su10.ru'
  );
$$;

CREATE OR REPLACE FUNCTION public.get_auth_users() RETURNS TABLE(id uuid, email text, created_at timestamp with time zone, last_sign_in_at timestamp with time zone, email_confirmed_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth', 'pg_temp'
    AS $$
BEGIN
  IF NOT (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.is_approved = true
    )
    OR EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = auth.uid() AND lower(u.email) = 'sadovnikov.d.y@su10.ru'
    )
  ) THEN
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
  IF NOT (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.is_approved = true
    )
    OR EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = auth.uid() AND lower(u.email) = 'sadovnikov.d.y@su10.ru'
    )
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав: подтверждать почту может только администратор'
      USING ERRCODE = '42501';
  END IF;

  UPDATE auth.users
  SET email_confirmed_at = now()
  WHERE id = target_user_id AND email_confirmed_at IS NULL;
END;
$$;

COMMIT;
