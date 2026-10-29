-- «Договоры и ДС»: подразделение договора — как у тендеров. Тело supabase/migrations/20261112_contracts_division.sql:
-- колонка той же таблицы contracts — правила по строкам и список шлюза не меняются.
--  • division — коды подразделений ВОР (как tenders.vor_division и dc_requests.division), NULL — не указано;
--  • ставится у договора (ДП), ДС показывают подразделение своего договора.
-- Только добавление, повтор безопасен.
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS division text;

ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_division_check;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_division_check
  CHECK (division IS NULL OR division IN ('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical', 'finishing'));

COMMENT ON COLUMN public.contracts.division IS
  'Подразделение договора — коды подразделений ВОР: monolith | nvf_spk | general | hvac_water | electrical | finishing; у ДС — подразделение договора';
