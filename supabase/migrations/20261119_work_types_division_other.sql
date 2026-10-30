-- Контрагенты: подразделение «Прочее» у видов работ (решение пользователя 30.10.2026: «на нераспределённые работы
-- добавь подразделение Прочее»).
--
--  • work_types.division принимает ещё 'other' — «Прочее»: аренда, охрана, клининг, проектирование, лаборатории
--    и всё, что не относится ни к одному подразделению ВОР. Только у видов работ: у тендеров, договоров и заявок на ДС
--    (tenders.vor_division, contracts.division, dc_requests.division) такого кода нет.
--  • Все виды работ, у которых подразделение не указано, получают «Прочее». «Не указано» (NULL) остаётся возможным —
--    например, у нового вида, которому подразделение ещё не выбрали.
--
-- Нужна 20261115_work_types_division (колонка division). Права не меняются. Повтор безопасен.
-- База нового портала (Яндекс) — migration/yandex/20261119_work_types_division_other.sql.
-- Проверка: migration/backup/checks/20261119.sql; откат — migration/rollback/20261119_work_types_division_other_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

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

COMMIT;
