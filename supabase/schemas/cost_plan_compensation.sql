-- Компенсация НДС и инфляции по объекту: «Планы затрат» → «Документы» → «Расчёт ПЗ», блок под подвкладками
-- «Прямые затраты» и «КП до перекидок». Сведения текстом, учитываются в каждом плане затрат объекта. Одна строка на
-- объект. Триггер «кто изменил», права (читает сотрудник, вносит и меняет только администратор — is_admin()) и
-- якоря файлов подвкладок (строки section_templates) — supabase/migrations/20261116_cost_plan_calc.sql.
CREATE TABLE public.cost_plan_compensation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES public.objects(id) ON DELETE CASCADE,
  vat_note text CHECK (vat_note IS NULL OR length(vat_note) <= 2000),
  inflation_note text CHECK (inflation_note IS NULL OR length(inflation_note) <= 2000),
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_plan_compensation_object_key UNIQUE (object_id)
);
