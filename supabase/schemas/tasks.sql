-- Раздел «Задачи» (task 433). Справочная копия схемы.
-- Источник истины — supabase/migrations/20260818_tasks_foundation.sql.
--
-- Жизненный цикл: new → in_progress → review (приёмка постановщиком) → done.
-- Файлы задачи — в s3_documents (owner_type='task', owner_id=tasks.id).
-- ФИО исполнителя/постановщика не денормализованы: резолвятся на клиенте из
-- вью employee_directory, чтобы переименование сотрудника отражалось везде.

-- Справочник сотрудников для выбора исполнителя. Нужен потому, что политика
-- user_roles_select_self_or_admin отдаёт обычному сотруднику только его строку,
-- поэтому вью намеренно SECURITY DEFINER (security_invoker = false).
-- is_negotiation_employee() в WHERE — чтобы справочник не читали логины
-- подрядчиков: они тоже authenticated (миграция 20260819_employee_directory_restrict).
CREATE OR REPLACE VIEW public.employee_directory
WITH (security_barrier = true) AS
  SELECT
    ur.user_id,
    ur.role,
    COALESCE(NULLIF(ur.full_name, ''), ur.email) AS display_name,
    ur.full_name,
    ur.email
  FROM public.user_roles ur
  WHERE ur.is_approved = true
    AND ur.counterparty_id IS NULL
    AND ur.role <> 'contractor'
    AND public.is_negotiation_employee();

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'in_progress', 'review', 'done', 'deferred')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high')),
  assignee_user_id UUID,                   -- ответственный (auth.users.id, без FK)
  created_by_user_id UUID,                 -- постановщик (auth.users.id, без FK)
  due_date DATE,
  completed_at TIMESTAMPTZ,
  object_id UUID REFERENCES objects(id) ON DELETE SET NULL,
  tender_id UUID REFERENCES tenders(id) ON DELETE SET NULL,
  contract_id UUID REFERENCES contracts(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,   -- порядок карточки в колонке доски
  deleted_at TIMESTAMPTZ,                  -- soft delete
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Соисполнители и наблюдатели.
CREATE TABLE IF NOT EXISTS task_participants (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('coassignee', 'watcher')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, user_id, kind)
);

CREATE TABLE IF NOT EXISTS task_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  is_done BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_user_id UUID,
  author_name TEXT,                        -- снимок ФИО автора
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,                -- created | status_changed | field_updated | soft_deleted | restored
  field_name TEXT,
  old_value JSONB,
  new_value JSONB,
  description TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by_role TEXT,
  changed_by_name TEXT
);

-- RLS: только подтверждённые сотрудники СУ-10 (контрагенты доступа не имеют),
-- и каждый видит ТОЛЬКО свои задачи — где он исполнитель, постановщик,
-- соисполнитель или наблюдатель. Все задачи компании видит администратор.
-- Актуальный набор политик и хелперы is_task_participant() / can_see_task() —
-- в миграции 20260821_tasks_visibility.sql.
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tasks_select_visible ON tasks
  FOR SELECT TO authenticated
  USING (
    public.is_negotiation_employee() AND (
      public.is_admin()
      OR assignee_user_id = auth.uid()
      OR created_by_user_id = auth.uid()
      OR public.is_task_participant(id)
    )
  );
-- INSERT вынесен отдельно: при вставке строки ещё нет, общий WITH CHECK
-- с предикатом видимости отбивал бы создание задачи.
CREATE POLICY tasks_insert_employee ON tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_negotiation_employee()
    AND (public.is_admin() OR created_by_user_id = auth.uid())
  );
