-- АВАРИЙНЫЙ ОТКАТ 20270225_dp_conclusion_registry_contract: договоры больше не создаются из «Заключения ДП», большого окна
-- исполнителю нет (страница без функций окна молчит, реестр и доска работают как до миграции).
-- Договоры, уже созданные из заявок, ОСТАЮТСЯ в реестре (с ними могли работать юристы); теряется только их ссылка на заявку —
-- происхождение видно по примечанию («Из заявки «Заключение ДП» ID …») и «Истории». Непрочитанные уведомления исполнителям
-- теряются. Перед откатом снимите список связей:
--   select c.display_id, r.request_number from public.contracts c join public.doc_check_requests r on r.id = c.doc_check_request_id;
-- Одной транзакцией, повтор безопасен. Подходит обеим базам (Supabase и Яндекса). Вместе с откатом уберите из шлюза функции окна
-- (server/osp-api/src/data/allow.json и db-sections.json: doc_check_assign_my_alerts, doc_check_assign_alerts_ack).
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS doc_check_dp_conclusion_contract ON public.doc_check_requests;
DROP TRIGGER IF EXISTS doc_check_assign_alert ON public.doc_check_requests;
DROP FUNCTION IF EXISTS public.doc_check_dp_conclusion_contract();
DROP FUNCTION IF EXISTS public.dp_conclusion_contract_create(uuid, text);
DROP FUNCTION IF EXISTS public.doc_check_assign_alert();
DROP FUNCTION IF EXISTS public.doc_check_assign_my_alerts();
DROP FUNCTION IF EXISTS public.doc_check_assign_alerts_ack(uuid[]);
DROP TABLE IF EXISTS public.doc_check_assign_alerts;
DROP INDEX IF EXISTS public.contracts_doc_check_request_uniq;
ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_doc_check_request_id_fkey;
ALTER TABLE public.contracts DROP COLUMN IF EXISTS doc_check_request_id;

COMMIT;
