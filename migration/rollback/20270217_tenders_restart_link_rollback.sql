-- АВАРИЙНЫЙ ОТКАТ 20270217_tenders_restart_link: у тендеров снова нет ссылки «перезапущен тендером № …»
-- (страница работает как до миграции: колонки нет — статус «Перезапуск» ставится без выбора нового тендера).
-- Статусы тендеров не меняются. ВНИМАНИЕ: теряются указанные ссылки. Перед откатом снимите их выгрузкой:
--   select t.public_tender_number as was, n.public_tender_number as by
--   from public.tenders t join public.tenders n on n.id = t.restarted_by_tender_id;
-- Одной транзакцией, повтор безопасен. Подходит обеим базам (Supabase и Яндекса).
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS public.idx_tenders_restarted_by_tender_id;
ALTER TABLE public.tenders DROP CONSTRAINT IF EXISTS tenders_restarted_by_not_self;
ALTER TABLE public.tenders DROP CONSTRAINT IF EXISTS tenders_restarted_by_tender_id_fkey;
ALTER TABLE public.tenders DROP COLUMN IF EXISTS restarted_by_tender_id;

COMMIT;
