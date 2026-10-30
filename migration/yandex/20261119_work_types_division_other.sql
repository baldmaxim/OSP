-- Контрагенты: подразделение «Прочее» у видов работ. Тело supabase/migrations/20261119_work_types_division_other.sql:
-- ограничение и данные той же таблицы work_types — правила по строкам и список шлюза не меняются.
--  • division принимает ещё 'other' — «Прочее» (только у видов работ, у тендеров, договоров и заявок на ДС его нет);
--  • все виды работ без подразделения получают «Прочее»; «Не указано» (NULL) по-прежнему возможно.
-- Нужна 20261115_work_types_division. Повтор безопасен.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'work_types' AND column_name = 'division') THEN
    RAISE EXCEPTION 'Сначала 20261115_work_types_division: у work_types нет колонки division';
  END IF;
END $$;

ALTER TABLE public.work_types DROP CONSTRAINT IF EXISTS work_types_division_check;
ALTER TABLE public.work_types ADD CONSTRAINT work_types_division_check
  CHECK (division IS NULL OR division IN ('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical', 'finishing', 'other'));

COMMENT ON COLUMN public.work_types.division IS
  'Подразделение вида работ — коды подразделений ВОР: monolith | nvf_spk | general | hvac_water | electrical | finishing, и other — «Прочее» (только у видов работ); NULL — не указано. Подразделения контрагента — подразделения его видов работ';

-- Нераспределённые виды работ — «Прочее».
UPDATE public.work_types SET division = 'other' WHERE division IS NULL;
