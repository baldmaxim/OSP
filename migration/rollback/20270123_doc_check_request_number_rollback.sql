-- АВАРИЙНЫЙ ОТКАТ 20270123_doc_check_request_number (обе базы): у заявок на проверку ДП/ДС снова нет постоянного номера.
-- Страница без колонки читает заявки прежним набором и номер «ID» не показывает — откатывать её не нужно.
-- Номера теряются насовсем: повторная миграция выдаст их заново тем же порядком (по дате создания), но заявки, созданные
-- после первой миграции, могут получить другие номера, чем видели люди. Перед откатом — сохранить соответствие:
--   select id, request_number from public.doc_check_requests order by request_number;
-- Supabase — SQL Editor; база Яндекса — psql под владельцем с отметкой служебной операции.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP INDEX IF EXISTS public.doc_check_requests_request_number_key;
ALTER TABLE public.doc_check_requests DROP COLUMN IF EXISTS request_number;
COMMIT;
