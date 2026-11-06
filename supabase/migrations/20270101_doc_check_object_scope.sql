-- «Заявки на проверку ДП/ДС»: руководители строительства и экономисты объекта видят заявки только своих объектов, только
-- просмотр (решение пользователя 06.11.2026).
--
-- До этого правило раздела пускало любого сотрудника ко всем заявкам (is_negotiation_employee()), а кому что видно, решала
-- страница. Привязку к объектам (user_roles.object_ids) страница не учитывала: руководитель строительства с правом
-- просмотра видел заявки всех объектов. Теперь в базе, как у «Заявки на ДП» (20261227, dp_request_scope()):
--  • doc_check_scope() — объекты вошедшего: NULL — все (администратор или сотрудник без привязки), иначе object_ids;
--  • заявки — прежнее условие «сотрудник» И объект свой; заявка без объекта сотруднику с привязкой не видна. Запись — так же:
--    свою заявку на чужой объект или без объекта не перенести;
--  • история, обсуждение, шаги — прежние права раздела И заявка своего объекта (имена правил прежние);
--  • права ролей: construction_manager и economist_object — просмотр раздела без правки. Обсуждение пишет любой, кто видит
--    раздел (20261124), — значит, и они, по заявкам своих объектов.
-- Сотрудников без привязки (юристы, инженеры и экономисты ОСП, администратор) это не меняет: условие объектов для них —
-- NULL, и проверка заканчивается на нём. Файлы заявок (s3_documents) правило не трогает: список и ссылка — по известному
-- id заявки, которого чужой объект на странице не увидит.
-- База Яндекса — migration/yandex/20270101_doc_check_object_scope.sql; проверка — migration/backup/checks/20270101.sql;
-- откат — migration/rollback/20270101_doc_check_object_scope_rollback.sql. Данные заявок не меняются. Повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.doc_check_scope() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN public.is_admin() THEN NULL
              ELSE (SELECT nullif(ur.object_ids, '{}'::uuid[]) FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1) END
$$;
REVOKE ALL ON FUNCTION public.doc_check_scope() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.doc_check_scope() TO authenticated, service_role;

DROP POLICY IF EXISTS doc_check_requests_employee_all ON public.doc_check_requests;
CREATE POLICY doc_check_requests_employee_all ON public.doc_check_requests FOR ALL TO authenticated
  USING ((SELECT public.is_negotiation_employee())
         AND ((SELECT public.doc_check_scope()) IS NULL OR object_id = ANY ((SELECT public.doc_check_scope())::uuid[])))
  WITH CHECK ((SELECT public.is_negotiation_employee())
              AND ((SELECT public.doc_check_scope()) IS NULL OR object_id = ANY ((SELECT public.doc_check_scope())::uuid[])));

DROP POLICY IF EXISTS doc_check_audit_employee_all ON public.doc_check_request_audit_log;
CREATE POLICY doc_check_audit_employee_all ON public.doc_check_request_audit_log FOR ALL TO authenticated
  USING ((SELECT public.is_negotiation_employee())
         AND ((SELECT public.doc_check_scope()) IS NULL
              OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                         WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[]))))
  WITH CHECK ((SELECT public.is_negotiation_employee())
              AND ((SELECT public.doc_check_scope()) IS NULL
                   OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                              WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[]))));

DROP POLICY IF EXISTS doc_check_request_comments_read ON public.doc_check_request_comments;
CREATE POLICY doc_check_request_comments_read ON public.doc_check_request_comments FOR SELECT TO authenticated
  USING ((SELECT public.osp_can('doc_check_requests', 'view'))
         AND ((SELECT public.doc_check_scope()) IS NULL
              OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                         WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[]))));
DROP POLICY IF EXISTS doc_check_request_comments_insert ON public.doc_check_request_comments;
CREATE POLICY doc_check_request_comments_insert ON public.doc_check_request_comments FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.osp_can('doc_check_requests', 'view'))
              AND ((SELECT public.doc_check_scope()) IS NULL
                   OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                              WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[]))));

DROP POLICY IF EXISTS doc_check_request_steps_read ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_read ON public.doc_check_request_steps FOR SELECT TO authenticated
  USING ((SELECT public.osp_can('doc_check_requests', 'view'))
         AND ((SELECT public.doc_check_scope()) IS NULL
              OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                         WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[]))));
DROP POLICY IF EXISTS doc_check_request_steps_insert ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_insert ON public.doc_check_request_steps FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.osp_can('doc_check_requests', 'edit'))
              AND ((SELECT public.doc_check_scope()) IS NULL
                   OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                              WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[]))));
DROP POLICY IF EXISTS doc_check_request_steps_update ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_update ON public.doc_check_request_steps FOR UPDATE TO authenticated
  USING (((SELECT public.osp_can('doc_check_requests', 'edit'))
          OR ((SELECT public.osp_can('doc_check_requests', 'view'))
              AND EXISTS (SELECT 1 FROM public.doc_check_requests r
                          WHERE r.id = request_id AND (SELECT auth.uid()) = ANY (r.assignee_ids))))
         AND ((SELECT public.doc_check_scope()) IS NULL
              OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                         WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[]))))
  WITH CHECK (((SELECT public.osp_can('doc_check_requests', 'edit'))
               OR ((SELECT public.osp_can('doc_check_requests', 'view'))
                   AND EXISTS (SELECT 1 FROM public.doc_check_requests r
                               WHERE r.id = request_id AND (SELECT auth.uid()) = ANY (r.assignee_ids))))
              AND ((SELECT public.doc_check_scope()) IS NULL
                   OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                              WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[]))));
DROP POLICY IF EXISTS doc_check_request_steps_delete ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_delete ON public.doc_check_request_steps FOR DELETE TO authenticated
  USING ((SELECT public.osp_can('doc_check_requests', 'edit'))
         AND ((SELECT public.doc_check_scope()) IS NULL
              OR EXISTS (SELECT 1 FROM public.doc_check_requests r
                         WHERE r.id = request_id AND r.object_id = ANY ((SELECT public.doc_check_scope())::uuid[]))));

-- Права ролей: просмотр без правки. Роли нет в справочнике — строка не заводится. Дальше — галочками в «Правах доступа».
INSERT INTO public.role_permissions (role, section, can_view, can_edit)
SELECT r.key, 'doc_check_requests', true, false
FROM public.roles r
WHERE r.key IN ('construction_manager', 'economist_object')
ON CONFLICT (role, section) DO UPDATE SET can_view = true, can_edit = false;

COMMIT;
