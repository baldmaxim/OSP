-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261112_contracts_division.sql (Supabase): договоры снова без подразделения
-- (реестр работает как до миграции: без плашки под «Работами» и без фильтра по подразделению).
-- ВНИМАНИЕ: выбранные подразделения теряются — перед откатом снимите их выгрузкой:
--   select id, display_id, division from public.contracts where division is not null;
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_division_check;
ALTER TABLE public.contracts DROP COLUMN IF EXISTS division;

COMMIT;
