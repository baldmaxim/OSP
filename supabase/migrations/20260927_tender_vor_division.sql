-- ВОРы и РД: подразделение, которое готовит ВОР по тендеру.
--
-- Коды → подписи (src/pages/VorsPage.jsx, VOR_DIVISIONS):
--   monolith     — Монолит
--   nvf_spk      — НВФ, СПК
--   general      — Общестроительные работы
--   hvac_water   — ОВ, ВК
--   electrical   — ЭОМ, СС
-- NULL — не указано. Миграция идемпотентна.

ALTER TABLE public.tenders
  ADD COLUMN IF NOT EXISTS vor_division TEXT;

ALTER TABLE public.tenders
  DROP CONSTRAINT IF EXISTS valid_vor_division;

ALTER TABLE public.tenders
  ADD CONSTRAINT valid_vor_division
  CHECK (vor_division IS NULL OR vor_division IN ('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical'));

CREATE INDEX IF NOT EXISTS idx_tenders_vor_division ON public.tenders(vor_division);

COMMENT ON COLUMN public.tenders.vor_division IS
  'Подразделение ВОР: monolith (Монолит) | nvf_spk (НВФ, СПК) | general (Общестроительные работы) | hvac_water (ОВ, ВК) | electrical (ЭОМ, СС)';
