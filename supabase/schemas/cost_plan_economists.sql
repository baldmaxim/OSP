-- Экономист ОСП по объекту — ответственный за планы затрат: «Планы затрат» и «Общая информация → Отделы» →
-- «Документы» → «Экономисты ОСП». Новому тендеру основного строительства форма тендера подставляет его в
-- tenders.cost_plan_responsible_id (сменить можно). Одна строка на объект.
-- Триггер «кто изменил», права (читает сотрудник, назначает только администратор — is_admin()) и начальное
-- назначение — supabase/migrations/20261110_cost_plan_economists.sql.
CREATE TABLE public.cost_plan_economists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES public.objects(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_plan_economists_object_key UNIQUE (object_id)
);
CREATE INDEX cost_plan_economists_contact_idx ON public.cost_plan_economists (contact_id);
