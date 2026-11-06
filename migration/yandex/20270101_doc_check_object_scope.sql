-- «Заявки на проверку ДП/ДС»: руководители строительства и экономисты объекта видят заявки только своих объектов, только
-- просмотр (решение пользователя 06.11.2026). Тело supabase/migrations/20270101_doc_check_object_scope.sql, там же зачем и как:
-- та же функция, те же условия и те же права ролей, иначе — только права под одну учётку:
--  • условия правил — в обёртке «пропуск → да; иначе роль из токена И условие», имена правил и их роли прежние;
--  • функция объектов вошедшего (SECURITY DEFINER) — с отметкой пропуска, как dp_request_scope() (20261227).
-- Блокировок таблиц, кроме коротких на смену правил, нет; данные заявок не меняются. Повтор безопасен.

-- ── Объекты вошедшего ────────────────────────────────────────────────────────────────────────────────
-- NULL — все (администратор или сотрудник без привязки, как scopedObjectIds на странице); иначе — его object_ids.
CREATE OR REPLACE FUNCTION public.doc_check_scope() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT CASE WHEN public.is_admin() THEN NULL
              ELSE (SELECT nullif(ur.object_ids, '{}'::uuid[]) FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1) END
$$;

-- ── Заявки и история: прежнее условие (сотрудник) И объект — свой ─────────────────────────────────────
-- Заявка без объекта сотруднику с привязкой не видна (object_id = ANY → NULL). Запись — так же: свою заявку на чужой
-- объект или без объекта не перенести.
DROP POLICY IF EXISTS doc_check_requests_employee_all ON public.doc_check_requests;
CREATE POLICY doc_check_requests_employee_all ON public.doc_check_requests FOR ALL TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_negotiation_employee())
                    AND ((SELECT public.doc_check_scope()) IS NULL OR object_id = ANY ((SELECT public.doc_check_scope())::uuid[]))) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_negotiation_employee())
                         AND ((SELECT public.doc_check_scope()) IS NULL OR object_id = ANY ((SELECT public.doc_check_scope())::uuid[]))) END);

DROP POLICY IF EXISTS doc_check_audit_employee_all ON public.doc_check_request_audit_log;
CREATE POLICY doc_check_audit_employee_all ON public.doc_check_request_audit_log FOR ALL TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_negotiation_employee())
                    AND ((SELECT public.doc_check_scope()) IS NULL
                         OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                                    WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[])))) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_negotiation_employee())
                         AND ((SELECT public.doc_check_scope()) IS NULL
                              OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                                         WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[])))) END);

-- ── Обсуждение и шаги (20261124): прежние права раздела И заявка своего объекта ──────────────────────
DROP POLICY IF EXISTS doc_check_request_comments_read ON public.doc_check_request_comments;
CREATE POLICY doc_check_request_comments_read ON public.doc_check_request_comments FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('doc_check_requests', 'view'))
                    AND ((SELECT public.doc_check_scope()) IS NULL
                         OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                                    WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[])))) END);
DROP POLICY IF EXISTS doc_check_request_comments_insert ON public.doc_check_request_comments;
CREATE POLICY doc_check_request_comments_insert ON public.doc_check_request_comments FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('doc_check_requests', 'view'))
                         AND ((SELECT public.doc_check_scope()) IS NULL
                              OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                                         WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[])))) END);

DROP POLICY IF EXISTS doc_check_request_steps_read ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_read ON public.doc_check_request_steps FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('doc_check_requests', 'view'))
                    AND ((SELECT public.doc_check_scope()) IS NULL
                         OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                                    WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[])))) END);
DROP POLICY IF EXISTS doc_check_request_steps_insert ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_insert ON public.doc_check_request_steps FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('doc_check_requests', 'edit'))
                         AND ((SELECT public.doc_check_scope()) IS NULL
                              OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                                         WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[])))) END);
DROP POLICY IF EXISTS doc_check_request_steps_update ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_update ON public.doc_check_request_steps FOR UPDATE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated'))
                    AND ((SELECT public.osp_can('doc_check_requests', 'edit'))
                         OR ((SELECT public.osp_can('doc_check_requests', 'view'))
                             AND EXISTS (SELECT 1 FROM public.doc_check_requests r
                                         WHERE r.id = request_id AND (SELECT auth.uid()) = ANY (r.assignee_ids))))
                    AND ((SELECT public.doc_check_scope()) IS NULL
                         OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                                    WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[])))) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated'))
                         AND ((SELECT public.osp_can('doc_check_requests', 'edit'))
                              OR ((SELECT public.osp_can('doc_check_requests', 'view'))
                                  AND EXISTS (SELECT 1 FROM public.doc_check_requests r
                                              WHERE r.id = request_id AND (SELECT auth.uid()) = ANY (r.assignee_ids))))
                         AND ((SELECT public.doc_check_scope()) IS NULL
                              OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                                         WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[])))) END);
DROP POLICY IF EXISTS doc_check_request_steps_delete ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_delete ON public.doc_check_request_steps FOR DELETE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('doc_check_requests', 'edit'))
                    AND ((SELECT public.doc_check_scope()) IS NULL
                         OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                                    WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[])))) END);

-- Имена правил и их роли — прежние; повтор записи безопасен.
INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'doc_check_requests', 'doc_check_requests_employee_all', ARRAY['authenticated']),
  ('public', 'doc_check_request_audit_log', 'doc_check_audit_employee_all', ARRAY['authenticated']),
  ('public', 'doc_check_request_comments', 'doc_check_request_comments_read', ARRAY['authenticated']),
  ('public', 'doc_check_request_comments', 'doc_check_request_comments_insert', ARRAY['authenticated']),
  ('public', 'doc_check_request_steps', 'doc_check_request_steps_read', ARRAY['authenticated']),
  ('public', 'doc_check_request_steps', 'doc_check_request_steps_insert', ARRAY['authenticated']),
  ('public', 'doc_check_request_steps', 'doc_check_request_steps_update', ARRAY['authenticated']),
  ('public', 'doc_check_request_steps', 'doc_check_request_steps_delete', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;

-- ── Права ролей: просмотр без правки ─────────────────────────────────────────────────────────────────
-- Руководитель строительства и экономист объекта: «Просмотр» раздела, «Редактирование» снято. Роли нет в справочнике —
-- строка не заводится. Дальше — галочками в «Правах доступа».
INSERT INTO public.role_permissions (role, section, can_view, can_edit)
SELECT r.key, 'doc_check_requests', true, false
FROM public.roles r
WHERE r.key IN ('construction_manager', 'economist_object')
ON CONFLICT (role, section) DO UPDATE SET can_view = true, can_edit = false;
