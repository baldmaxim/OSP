-- АВАРИЙНЫЙ ОТКАТ 20270221_doc_check_tender_link: у заявок доски ДП/ДС снова нет привязки к тендеру (страница работает как до
-- миграции: колонки нет — поле «Тендер» у «Заключения ДП» не показывается и не пишется). Записи истории о смене тендера остаются
-- (журнал заявки не правится), окно показывает их как «Тендер: —». ВНИМАНИЕ: теряются указанные привязки. Перед откатом снимите их:
--   select r.id, r.request_number, t.public_tender_number
--   from public.doc_check_requests r join public.tenders t on t.id = r.tender_id;
-- Одной транзакцией, повтор безопасен. Подходит обеим базам (Supabase и Яндекса). Вместе с откатом верните в шлюзе прежний
-- список колонок вставки подающего (server/osp-api/src/data/db-sections.json, doc_check_requests — без tender_id).
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS doc_check_requests_tender_history ON public.doc_check_requests;
DROP FUNCTION IF EXISTS public.doc_check_requests_tender_history();
DROP INDEX IF EXISTS public.idx_doc_check_requests_tender_id;
ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_tender_id_fkey;
ALTER TABLE public.doc_check_requests DROP COLUMN IF EXISTS tender_id;

COMMIT;
