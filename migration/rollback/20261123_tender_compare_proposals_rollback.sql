-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261123_tender_compare_proposals.sql (Supabase): функции «все КП тендера одним
-- запросом» больше нет — «Сравнение КП» само переходит на прежнее чтение страницами (ответ PGRST202). Данные не
-- меняются. Одной транзакцией, повтор безопасен.
BEGIN;
DROP FUNCTION IF EXISTS public.tender_compare_proposals(uuid);
COMMIT;
