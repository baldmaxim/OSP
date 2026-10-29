-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261117_dc_request_submission_responsible.sql (Supabase): снимается
-- ограничение. Колонки и данные НЕ удаляются — назначенные ответственные за статус ОКС сохраняются, страница их
-- по-прежнему показывает и пишет; повторное применение миграции вернёт ограничение.
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.dc_requests DROP CONSTRAINT IF EXISTS dc_requests_submission_resp_check;

COMMIT;
