-- АВАРИЙНЫЙ ОТКАТ 20261230_dc_request_notes: «Заявки на ДС» снова без примечания
-- (страница работает как до миграции: колонки нет — полосы нет).
-- ВНИМАНИЕ: теряются написанные примечания. Перед откатом снимите их выгрузкой:
--   select id, request_number, notes from public.dc_requests where notes is not null;
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.dc_requests DROP CONSTRAINT IF EXISTS dc_requests_notes_check;
ALTER TABLE public.dc_requests DROP COLUMN IF EXISTS notes;

COMMIT;
