-- Отделы компании («Общая информация» → «Отделы»). Миграция — supabase/migrations/20261104_company_departments.sql
-- (там же триггер очистки, права и начальный список).
CREATE TABLE public.company_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sort_order integer NOT NULL DEFAULT 0,
  block text NOT NULL DEFAULT '' CHECK (length(block) <= 200),
  name text NOT NULL CHECK (name <> '' AND length(name) <= 300),
  duties text NOT NULL DEFAULT '' CHECK (length(duties) <= 4000),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  -- [{"name": ФИО, "position": должность или за что отвечает, "phone": телефон}]
  contacts jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(contacts) = 'array' AND jsonb_array_length(contacts) <= 20),
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_departments_sort_idx ON public.company_departments (sort_order);
-- RLS: SELECT — osp_is_employee(); INSERT / UPDATE / DELETE — is_admin().
