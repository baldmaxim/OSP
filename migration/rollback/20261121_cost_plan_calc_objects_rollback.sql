-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261121_cost_plan_calc_objects.sql (Supabase): у компенсации НДС и инфляции
-- снова только текст (как после 20261116), триггер — без проверки документа.
-- ВНИМАНИЕ: «да / нет», проценты и ссылки на подтверждающие документы теряются — перед откатом снимите выгрузкой:
--   select object_id, vat_compensated, vat_percent, vat_document_id, inflation_compensated, inflation_percent,
--          inflation_document_id from public.cost_plan_compensation order by object_id;
-- Документы объектов по расчёту (s3_documents, doc_category cost_plan_direct_costs / cost_plan_kp_before_transfers)
-- откат не трогает. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.cost_plan_compensation DROP CONSTRAINT IF EXISTS cost_plan_compensation_vat_check;
ALTER TABLE public.cost_plan_compensation DROP CONSTRAINT IF EXISTS cost_plan_compensation_inflation_check;
ALTER TABLE public.cost_plan_compensation
  DROP COLUMN IF EXISTS vat_compensated,
  DROP COLUMN IF EXISTS vat_percent,
  DROP COLUMN IF EXISTS vat_document_id,
  DROP COLUMN IF EXISTS inflation_compensated,
  DROP COLUMN IF EXISTS inflation_percent,
  DROP COLUMN IF EXISTS inflation_document_id;

CREATE OR REPLACE FUNCTION public.cost_plan_compensation_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.cost_plan_compensation_touch() FROM PUBLIC, anon;

-- Строки, в которых были только новые поля, становятся пустыми — убираем (как «оба поля пустые» в портале).
DELETE FROM public.cost_plan_compensation WHERE vat_note IS NULL AND inflation_note IS NULL;

COMMIT;
