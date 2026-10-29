-- «Договоры и ДС»: подразделение договора — как у тендеров (решение пользователя 29.10.2026).
--
--  • contracts.division — те же коды, что подразделение ВОР у тендеров (tenders.vor_division) и подразделение
--    заявки на ДС (dc_requests.division): monolith | nvf_spk | general | hvac_water | electrical | finishing.
--    NULL — не указано. В реестре — плашка под «Работами» и фильтр в заголовке колонки.
--  • Ставится у договора (ДП); ДС показывают подразделение своего договора (src/utils/contractDivision.js), их
--    колонка не заполняется.
--  • Завершённый документ подразделение менять не мешает: колонки нет в списке «замороженных» полей
--    contracts_hierarchy_guard — это не условие договора.
--
-- Права не меняются: колонка той же таблицы contracts. Только добавление, повтор безопасен.
-- База нового портала (Яндекс) — migration/yandex/20261112_contracts_division.sql.
-- Проверка: migration/backup/checks/20261112.sql; откат — migration/rollback/20261112_contracts_division_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS division text;

ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_division_check;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_division_check
  CHECK (division IS NULL OR division IN ('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical', 'finishing'));

COMMENT ON COLUMN public.contracts.division IS
  'Подразделение договора — коды подразделений ВОР: monolith | nvf_spk | general | hvac_water | electrical | finishing; у ДС — подразделение договора';

COMMIT;
