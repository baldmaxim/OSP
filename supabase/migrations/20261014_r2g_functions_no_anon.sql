-- Р2g (первая часть): функции портала без входа не вызываются.
--
-- ПРОБЛЕМА (замер прав, 2026-10-12). Анониму — любому, у кого есть публичный ключ из сборки сайта, —
-- было выдано право вызывать 19 функций: проверки прав (is_admin, is_portal_employee, is_my_contract,
-- is_my_tender, current_counterparty_id, can_see_task, is_task_participant, is_negotiation_employee,
-- vor_requests_can_access), touch_last_login, admin_delete_user, пересчёт реестра и семь вспомогательных
-- (kp_norm_*, psdc_*). Данные через них не отдавались, но правило «без входа — только публичная витрина»
-- не выполнялось: это лишняя поверхность для перебора и нагрузки.
--
-- РЕШЕНИЕ. У этих функций право вызова снято у анонима и у «всех» (PUBLIC); вошедшему (authenticated) и
-- служебному ключу (service_role) оно выдано явно — для них ничего не меняется.
-- Публичная витрина (две политики для анонима на tenders и objects) функций не вызывает и работает как
-- раньше. Триггерные функции не трогаем: напрямую они не вызываются.
--
-- Данные не меняются, таблицы не блокируются. Повтор безопасен.
-- Аварийный откат — migration/rollback/20261014_r2g_rollback.sql. Всё — одной транзакцией.
BEGIN;
SET LOCAL lock_timeout = '10s';

REVOKE ALL ON FUNCTION public.admin_delete_user(target_user_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(target_user_id uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.can_see_task(task_uuid uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_see_task(task_uuid uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.current_counterparty_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_counterparty_id() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_my_contract(contract_uuid uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_my_contract(contract_uuid uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_my_tender(tender_uuid uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_my_tender(tender_uuid uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_negotiation_employee() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_negotiation_employee() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_portal_employee() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_portal_employee() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_task_participant(task_uuid uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_task_participant(task_uuid uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_norm_name(s text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kp_norm_name(s text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.kp_norm_unit(u text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kp_norm_unit(u text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.psdc_cell_value(p_cell jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.psdc_cell_value(p_cell jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.psdc_feature_started_at() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.psdc_feature_started_at() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.psdc_norm_header(p_text text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.psdc_norm_header(p_text text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.psdc_number_message(p_label text, p_err text, p_raw text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.psdc_number_message(p_label text, p_err text, p_raw text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.psdc_parse_decimal(p_cell jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.psdc_parse_decimal(p_cell jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.refresh_rates_registry() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_rates_registry() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.touch_last_login() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touch_last_login() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.vor_requests_can_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vor_requests_can_access() TO authenticated, service_role;

COMMIT;
