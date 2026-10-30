-- Компенсация НДС и инфляции по объекту: «Планы затрат» → «Документы» → «Расчёт ПЗ», правая часть карточки объекта
-- («Компенсация НДС», под ней «Инфляция»). Учитывается в каждом плане затрат объекта. Одна строка на объект.
-- У каждого пункта — да / нет (NULL — не указано), процент и подтверждающий документ из «Документов» карточки
-- объекта (договор генподряда или ДС; только при «да», только этого объекта — проверяет триггер), примечание.
-- Триггер «кто изменил», права (читает сотрудник, вносит и меняет только администратор — is_admin()) и якоря файлов
-- инструкций (строки section_templates) — supabase/migrations/20261116_cost_plan_calc.sql; поля пунктов и проверка
-- документа — 20261121_cost_plan_calc_objects.sql.
CREATE TABLE public.cost_plan_compensation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES public.objects(id) ON DELETE CASCADE,
  vat_note text CHECK (vat_note IS NULL OR length(vat_note) <= 2000),
  inflation_note text CHECK (inflation_note IS NULL OR length(inflation_note) <= 2000),
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  vat_compensated boolean,
  vat_percent numeric(5,2),
  vat_document_id uuid REFERENCES public.object_documents(id) ON DELETE SET NULL,
  inflation_compensated boolean,
  inflation_percent numeric(5,2),
  inflation_document_id uuid REFERENCES public.object_documents(id) ON DELETE SET NULL,
  CONSTRAINT cost_plan_compensation_object_key UNIQUE (object_id),
  CONSTRAINT cost_plan_compensation_vat_check CHECK (
    (vat_percent IS NULL OR (vat_percent > 0 AND vat_percent <= 100))
    AND (vat_compensated IS TRUE OR (vat_percent IS NULL AND vat_document_id IS NULL))),
  CONSTRAINT cost_plan_compensation_inflation_check CHECK (
    (inflation_percent IS NULL OR (inflation_percent > 0 AND inflation_percent <= 100))
    AND (inflation_compensated IS TRUE OR (inflation_percent IS NULL AND inflation_document_id IS NULL)))
);
