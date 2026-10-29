-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261115_work_types_division.sql (Supabase): виды работ снова без подразделения
-- (реестр контрагентов работает как до миграции: без плашек подразделений и фильтра по ним).
-- ВНИМАНИЕ: подразделения видов работ теряются — перед откатом снимите их выгрузкой:
--   select name, division from public.work_types where division is not null order by division, name;
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.work_types DROP CONSTRAINT IF EXISTS work_types_division_check;
ALTER TABLE public.work_types DROP COLUMN IF EXISTS division;

COMMIT;
