-- АВАРИЙНЫЙ ОТКАТ 20270121_audit_trail (только база Яндекса): триггеры журналов снимаются — журналы для экрана снова
-- принимают автора и время из браузера, их можно править и удалять (как до миграции); журнал базы перестаёт пополняться.
-- Данные НЕ удаляются: osp_private.data_audit_log и колонка changed_by остаются (повторное применение миграции продолжит с ними).
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $rollback$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contracts', 'tenders', 'counterparties', 'dc_requests', 'doc_check_requests', 'tasks'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS osp_data_audit ON public.%I', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['contract_audit_log', 'tender_audit_log', 'counterparty_audit_log', 'dc_request_audit_log',
                           'doc_check_request_audit_log', 'task_audit_log'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_log_stamp ON public.%I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS audit_log_guard ON public.%I', t);
  END LOOP;
END
$rollback$;

DROP FUNCTION IF EXISTS public.audit_log_guard();
DROP FUNCTION IF EXISTS public.audit_log_stamp();
DROP FUNCTION IF EXISTS public.audit_log_parent_exists(text, uuid);
DROP FUNCTION IF EXISTS osp_private.data_audit_row();
DROP FUNCTION IF EXISTS osp_private.data_audit_write(text, uuid, text, uuid, text, jsonb);

COMMIT;
