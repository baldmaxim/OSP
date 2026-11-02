-- Журнал файлов «Расчёта ПЗ»: «Планы затрат» → «Документы» → «Журнал» — кто и когда прикрепил и открепил инструкцию или
-- документ объекта. Пишет только триггер s3_documents_cost_plan_calc_log на s3_documents; читает сотрудник. Без внешних
-- ключей: запись переживает файл и объект (имя файла и название объекта — слепком). Триггер, права и начальные записи
-- уже прикреплённых файлов — supabase/migrations/20261130_cost_plan_calc_file_log.sql.
CREATE TABLE public.cost_plan_calc_file_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('attach', 'detach')),
  document_id uuid NOT NULL,
  file_name text NOT NULL,
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  doc_category text NOT NULL,
  object_name text,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
