-- АВАРИЙНЫЙ ОТКАТ 20270101_doc_check_object_scope (Supabase): правила заявок на проверку ДП/ДС, их истории, обсуждения и
-- шагов — снова как в 20260905 и 20261124, без ограничения по объектам; функция doc_check_scope() убирается.
-- Права ролей не возвращаются: прежних значений нет (у руководителя строительства просмотр мог быть снят администратором,
-- у экономиста объекта строки не было). Снять просмотр — галочкой в «Правах доступа». Страница и после отката показывает
-- сотруднику с привязкой только заявки своих объектов, но прямой запрос снова отдаст ему все.
-- База Яндекса: применённую миграцию не правят — откат там новой миграцией с этими же условиями в обёртке одной учётки.
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP POLICY IF EXISTS doc_check_requests_employee_all ON public.doc_check_requests;
CREATE POLICY doc_check_requests_employee_all ON public.doc_check_requests FOR ALL TO authenticated
  USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());

DROP POLICY IF EXISTS doc_check_audit_employee_all ON public.doc_check_request_audit_log;
CREATE POLICY doc_check_audit_employee_all ON public.doc_check_request_audit_log FOR ALL TO authenticated
  USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());

DROP POLICY IF EXISTS doc_check_request_comments_read ON public.doc_check_request_comments;
CREATE POLICY doc_check_request_comments_read ON public.doc_check_request_comments FOR SELECT TO authenticated
  USING ((SELECT public.osp_can('doc_check_requests', 'view')));
DROP POLICY IF EXISTS doc_check_request_comments_insert ON public.doc_check_request_comments;
CREATE POLICY doc_check_request_comments_insert ON public.doc_check_request_comments FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.osp_can('doc_check_requests', 'view')));

DROP POLICY IF EXISTS doc_check_request_steps_read ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_read ON public.doc_check_request_steps FOR SELECT TO authenticated
  USING ((SELECT public.osp_can('doc_check_requests', 'view')));
DROP POLICY IF EXISTS doc_check_request_steps_insert ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_insert ON public.doc_check_request_steps FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.osp_can('doc_check_requests', 'edit')));
DROP POLICY IF EXISTS doc_check_request_steps_update ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_update ON public.doc_check_request_steps FOR UPDATE TO authenticated
  USING ((SELECT public.osp_can('doc_check_requests', 'edit'))
         OR ((SELECT public.osp_can('doc_check_requests', 'view'))
             AND EXISTS (SELECT 1 FROM public.doc_check_requests r
                         WHERE r.id = request_id AND (SELECT auth.uid()) = ANY (r.assignee_ids))))
  WITH CHECK ((SELECT public.osp_can('doc_check_requests', 'edit'))
              OR ((SELECT public.osp_can('doc_check_requests', 'view'))
                  AND EXISTS (SELECT 1 FROM public.doc_check_requests r
                              WHERE r.id = request_id AND (SELECT auth.uid()) = ANY (r.assignee_ids))));
DROP POLICY IF EXISTS doc_check_request_steps_delete ON public.doc_check_request_steps;
CREATE POLICY doc_check_request_steps_delete ON public.doc_check_request_steps FOR DELETE TO authenticated
  USING ((SELECT public.osp_can('doc_check_requests', 'edit')));

DROP FUNCTION IF EXISTS public.doc_check_scope();

COMMIT;
