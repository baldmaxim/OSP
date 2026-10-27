-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261108_dc_request_submission_check.sql (Supabase): снимается триггер подписи
-- «кто и когда сменил статус ОКС». Колонки и данные НЕ удаляются — статусы и комментарии заявок сохраняются, страница
-- их по-прежнему показывает и пишет (подпись при этом не обновляется); повторное применение миграции вернёт триггер.
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS dc_requests_submission_stamp ON public.dc_requests;
DROP FUNCTION IF EXISTS public.dc_requests_submission_stamp();

COMMIT;
