-- «Планы затрат» → «Документы» → «Расчёт ПЗ» по объектам: у НДС и инфляции — да / нет, процент и подтверждающий
-- документ объекта. Тело supabase/migrations/20261121_cost_plan_calc_objects.sql: те же колонки, ограничения и
-- триггер; колонки той же таблицы cost_plan_compensation — правила по строкам и список шлюза не меняются.
--  • *_compensated — да / нет (NULL — не указано); *_percent — процент, только при «да»;
--  • *_document_id — договор генподряда или ДС из «Документов» этого объекта, только при «да» (проверяет триггер,
--    удаление документа снимает ссылку).
-- Документы объекта по расчёту — файлы объекта (s3_documents), без миграции. Нужна 20261116_cost_plan_calc.
-- Только добавление, повтор безопасен.
DO $$
BEGIN
  IF to_regclass('public.cost_plan_compensation') IS NULL THEN
    RAISE EXCEPTION 'Сначала 20261116_cost_plan_calc: нет таблицы cost_plan_compensation';
  END IF;
END $$;

ALTER TABLE public.cost_plan_compensation
  ADD COLUMN IF NOT EXISTS vat_compensated boolean,
  ADD COLUMN IF NOT EXISTS vat_percent numeric(5,2),
  ADD COLUMN IF NOT EXISTS vat_document_id uuid REFERENCES public.object_documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS inflation_compensated boolean,
  ADD COLUMN IF NOT EXISTS inflation_percent numeric(5,2),
  ADD COLUMN IF NOT EXISTS inflation_document_id uuid REFERENCES public.object_documents(id) ON DELETE SET NULL;

ALTER TABLE public.cost_plan_compensation DROP CONSTRAINT IF EXISTS cost_plan_compensation_vat_check;
ALTER TABLE public.cost_plan_compensation ADD CONSTRAINT cost_plan_compensation_vat_check CHECK (
  (vat_percent IS NULL OR (vat_percent > 0 AND vat_percent <= 100))
  AND (vat_compensated IS TRUE OR (vat_percent IS NULL AND vat_document_id IS NULL)));
ALTER TABLE public.cost_plan_compensation DROP CONSTRAINT IF EXISTS cost_plan_compensation_inflation_check;
ALTER TABLE public.cost_plan_compensation ADD CONSTRAINT cost_plan_compensation_inflation_check CHECK (
  (inflation_percent IS NULL OR (inflation_percent > 0 AND inflation_percent <= 100))
  AND (inflation_compensated IS TRUE OR (inflation_percent IS NULL AND inflation_document_id IS NULL)));

COMMENT ON COLUMN public.cost_plan_compensation.vat_compensated IS 'Компенсация НДС: да / нет; NULL — не указано';
COMMENT ON COLUMN public.cost_plan_compensation.vat_percent IS 'Компенсация НДС, % — только при «да»';
COMMENT ON COLUMN public.cost_plan_compensation.vat_document_id IS
  'Подтверждающий ДС (или договор генподряда) из документов этого объекта — только при «да»';
COMMENT ON COLUMN public.cost_plan_compensation.inflation_compensated IS 'Инфляция: да / нет; NULL — не указано';
COMMENT ON COLUMN public.cost_plan_compensation.inflation_percent IS 'Инфляция, % — только при «да»';
COMMENT ON COLUMN public.cost_plan_compensation.inflation_document_id IS
  'Подтверждающий документ (ДС или договор генподряда) из документов этого объекта — только при «да»';

-- Тот же триггер «кто изменил» + проверка: подтверждающий документ — из документов того же объекта.
CREATE OR REPLACE FUNCTION public.cost_plan_compensation_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.vat_document_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.object_documents d WHERE d.id = NEW.vat_document_id AND d.object_id = NEW.object_id) THEN
    RAISE EXCEPTION 'Подтверждающий документ НДС — не из документов этого объекта' USING ERRCODE = '23514';
  END IF;
  IF NEW.inflation_document_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.object_documents d WHERE d.id = NEW.inflation_document_id AND d.object_id = NEW.object_id) THEN
    RAISE EXCEPTION 'Подтверждающий документ инфляции — не из документов этого объекта' USING ERRCODE = '23514';
  END IF;
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
