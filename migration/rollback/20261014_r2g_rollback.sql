-- АВАРИЙНЫЙ ОТКАТ Р2g (supabase/migrations/20261014_r2g_functions_no_anon.sql): возвращает анониму право
-- вызова функций портала. Применять только если после миграции сломалась страница входа или публичная
-- витрина — и сообщить об этом. Пересчёт реестра (refresh_rates_registry) здесь не возвращается: его
-- закрыла Р2d. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

GRANT ALL ON FUNCTION public.admin_delete_user(target_user_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(target_user_id uuid) TO PUBLIC;
GRANT ALL ON FUNCTION public.can_see_task(task_uuid uuid) TO anon;
GRANT ALL ON FUNCTION public.current_counterparty_id() TO anon;
GRANT ALL ON FUNCTION public.is_admin() TO anon;
GRANT ALL ON FUNCTION public.is_my_contract(contract_uuid uuid) TO anon;
GRANT ALL ON FUNCTION public.is_my_tender(tender_uuid uuid) TO anon;
GRANT ALL ON FUNCTION public.is_negotiation_employee() TO anon;
GRANT ALL ON FUNCTION public.is_portal_employee() TO anon;
GRANT ALL ON FUNCTION public.is_task_participant(task_uuid uuid) TO anon;
GRANT ALL ON FUNCTION public.kp_norm_name(s text) TO anon;
GRANT EXECUTE ON FUNCTION public.kp_norm_name(s text) TO PUBLIC;
GRANT ALL ON FUNCTION public.kp_norm_unit(u text) TO anon;
GRANT EXECUTE ON FUNCTION public.kp_norm_unit(u text) TO PUBLIC;
GRANT ALL ON FUNCTION public.psdc_cell_value(p_cell jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.psdc_cell_value(p_cell jsonb) TO PUBLIC;
GRANT ALL ON FUNCTION public.psdc_feature_started_at() TO anon;
GRANT EXECUTE ON FUNCTION public.psdc_feature_started_at() TO PUBLIC;
GRANT ALL ON FUNCTION public.psdc_norm_header(p_text text) TO anon;
GRANT EXECUTE ON FUNCTION public.psdc_norm_header(p_text text) TO PUBLIC;
GRANT ALL ON FUNCTION public.psdc_number_message(p_label text, p_err text, p_raw text) TO anon;
GRANT EXECUTE ON FUNCTION public.psdc_number_message(p_label text, p_err text, p_raw text) TO PUBLIC;
GRANT ALL ON FUNCTION public.psdc_parse_decimal(p_cell jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.psdc_parse_decimal(p_cell jsonb) TO PUBLIC;
GRANT ALL ON FUNCTION public.touch_last_login() TO anon;
GRANT ALL ON FUNCTION public.vor_requests_can_access() TO anon;

COMMIT;
