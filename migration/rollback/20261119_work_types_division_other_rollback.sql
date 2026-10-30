-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261119_work_types_division_other.sql (Supabase): у видов работ снова нет
-- «Прочего» — такие виды «Не указано» (как после 20261115).
-- ВНИМАНИЕ: «Прочее», поставленное и в портале после миграции, тоже снимается — перед откатом снимите выгрузкой:
--   select name from public.work_types where division = 'other' order by name;
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

UPDATE public.work_types SET division = NULL WHERE division = 'other';

ALTER TABLE public.work_types DROP CONSTRAINT IF EXISTS work_types_division_check;
ALTER TABLE public.work_types ADD CONSTRAINT work_types_division_check
  CHECK (division IS NULL OR division IN ('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical', 'finishing'));

COMMENT ON COLUMN public.work_types.division IS
  'Подразделение вида работ — коды подразделений ВОР: monolith | nvf_spk | general | hvac_water | electrical | finishing; NULL — не указано. Подразделения контрагента — подразделения его видов работ';

COMMIT;
