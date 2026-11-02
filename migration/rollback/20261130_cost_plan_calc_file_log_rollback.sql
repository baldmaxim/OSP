-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261130_cost_plan_calc_file_log.sql (Supabase): файлы «Расчёта ПЗ» снова только
-- у администратора, новые действия в журнал не пишутся. Таблица журнала с записями остаётся: это история, она не
-- мешает. Файлы и права других разделов откат не трогает. Одной транзакцией, повтор безопасен; повторная миграция
-- возвращает триггер и выдаёт право экономисту ОСП заново.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS s3_documents_cost_plan_calc_log ON public.s3_documents;
DROP FUNCTION IF EXISTS public.cost_plan_calc_file_log_write();
DELETE FROM public.role_permissions WHERE section = 'cost_plan_docs';

COMMIT;
