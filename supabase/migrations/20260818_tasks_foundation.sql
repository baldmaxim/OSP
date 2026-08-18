-- task 433: раздел «Задачи» — распределение работы по сотрудникам.
--
-- Модель по образцу Битрикс24/YouGile, но с привязкой к сущностям этой системы:
--   задача → объект / тендер / договор.
-- Жизненный цикл: new → in_progress → review (приёмка постановщиком) → done.
-- Файлы задачи — в s3_documents (owner_type='task', owner_id=tasks.id).
--
-- Миграция идемпотентна: можно применять повторно после сбоя.
-- ЗАВИСИМОСТЬ: требует применённой 20260815_contract_negotiation_foundation.sql —
-- оттуда берётся функция public.is_negotiation_employee(), на которой стоит RLS.

-- ────────────────────────────────────────────────────────────────────────────
-- 0) Справочник сотрудников для выбора исполнителя.
--
-- Без него выпадающий список исполнителей пуст у всех, кроме админа: политика
-- user_roles_select_self_or_admin (миграция 20260614) отдаёт обычному сотруднику
-- ТОЛЬКО его собственную строку в user_roles. Вью выполняется с правами владельца
-- (security_invoker = false по умолчанию) → читает user_roles в обход RLS, как это
-- уже сделано для kp_rates_registry / supply_rates_registry.
--
-- Отдаёт только ФИО/почту/роль подтверждённых сотрудников (контрагенты исключены).
CREATE OR REPLACE VIEW public.employee_directory AS
  SELECT
    ur.user_id,
    ur.role,
    COALESCE(NULLIF(ur.full_name, ''), ur.email) AS display_name,
    ur.full_name,
    ur.email
  FROM public.user_roles ur
  WHERE ur.is_approved = true
    AND ur.counterparty_id IS NULL
    AND ur.role <> 'contractor';

REVOKE ALL ON public.employee_directory FROM anon;
GRANT SELECT ON public.employee_directory TO authenticated;

COMMENT ON VIEW public.employee_directory IS
  'Справочник сотрудников СУ-10 (подтверждённые логины без привязки к контрагенту) для выбора исполнителя задач';

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Задачи.
--
-- assignee_user_id / created_by_user_id — auth.users.id БЕЗ FK (так же, как
-- user_roles.user_id): схема auth живёт своей жизнью, а ФИО резолвятся из
-- employee_directory на клиенте, чтобы переименование сотрудника отражалось везде.
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'in_progress', 'review', 'done', 'deferred')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high')),
  assignee_user_id UUID,                   -- ответственный (кто делает)
  created_by_user_id UUID,                 -- постановщик (кто принимает работу)
  due_date DATE,                           -- крайний срок
  completed_at TIMESTAMPTZ,                -- момент перехода в done
  -- Связи с разделами системы; ON DELETE SET NULL — удаление объекта/тендера
  -- не уносит задачу, просто снимает связь.
  object_id UUID REFERENCES objects(id) ON DELETE SET NULL,
  tender_id UUID REFERENCES tenders(id) ON DELETE SET NULL,
  contract_id UUID REFERENCES contracts(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,   -- порядок карточки внутри колонки доски
  deleted_at TIMESTAMPTZ,                  -- soft delete (вкладка «Удалённые»)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tasks IS 'Задачи сотрудникам (task 433)';
COMMENT ON COLUMN tasks.status IS 'new | in_progress | review (на приёмке у постановщика) | done | deferred';
COMMENT ON COLUMN tasks.priority IS 'low | normal | high';
COMMENT ON COLUMN tasks.assignee_user_id IS 'Ответственный — auth.users.id (без FK, как user_roles.user_id)';
COMMENT ON COLUMN tasks.created_by_user_id IS 'Постановщик — auth.users.id; он принимает работу из статуса review';
COMMENT ON COLUMN tasks.sort_order IS 'Порядок карточки внутри колонки канбан-доски';

CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_object_id ON tasks(object_id);
CREATE INDEX IF NOT EXISTS idx_tasks_tender_id ON tasks(tender_id);
CREATE INDEX IF NOT EXISTS idx_tasks_contract_id ON tasks(contract_id);
-- Основная выборка страницы — только живые задачи.
CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(status, sort_order) WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Соисполнители и наблюдатели.
CREATE TABLE IF NOT EXISTS task_participants (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('coassignee', 'watcher')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, user_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_task_participants_user ON task_participants(user_id);
COMMENT ON TABLE task_participants IS 'Соисполнители (coassignee) и наблюдатели (watcher) задачи';

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Чек-лист задачи.
CREATE TABLE IF NOT EXISTS task_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  is_done BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_checklist_task_id ON task_checklist_items(task_id, sort_order);

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Обсуждение задачи. Автор денормализован (как в contract_clause_comments):
--    переименование сотрудника не переписывает переписку задним числом.
CREATE TABLE IF NOT EXISTS task_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_user_id UUID,
  author_name TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task_id ON task_comments(task_id, created_at);

-- ────────────────────────────────────────────────────────────────────────────
-- 5) История изменений (зеркало dc_request_audit_log).
CREATE TABLE IF NOT EXISTS task_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,               -- created | status_changed | field_updated | soft_deleted | restored
  field_name TEXT,
  old_value JSONB,
  new_value JSONB,
  description TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by_role TEXT,
  changed_by_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_audit_log_task_id ON task_audit_log(task_id);
CREATE INDEX IF NOT EXISTS idx_task_audit_log_changed_at ON task_audit_log(changed_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 6) Триггер updated_at.
CREATE OR REPLACE FUNCTION update_tasks_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks;
CREATE TRIGGER trg_tasks_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_tasks_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- 7) RLS: задачи — внутренний инструмент, доступ только подтверждённым сотрудникам
--    СУ-10. Контрагенты не видят их вовсе (is_negotiation_employee() из 20260815).
--    Организационные правила («кто может принять работу») — на уровне UI: жёсткие
--    триггеры здесь только мешали бы админу разгребать чужие задачи.
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tasks_employee_all ON tasks;
DROP POLICY IF EXISTS task_participants_employee_all ON task_participants;
DROP POLICY IF EXISTS task_checklist_employee_all ON task_checklist_items;
DROP POLICY IF EXISTS task_comments_employee_all ON task_comments;
DROP POLICY IF EXISTS task_audit_log_employee_all ON task_audit_log;

CREATE POLICY tasks_employee_all ON tasks
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());
CREATE POLICY task_participants_employee_all ON task_participants
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());
CREATE POLICY task_checklist_employee_all ON task_checklist_items
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());
CREATE POLICY task_comments_employee_all ON task_comments
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());
CREATE POLICY task_audit_log_employee_all ON task_audit_log
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());

-- ────────────────────────────────────────────────────────────────────────────
-- 8) Права раздела «Задачи». Ставить задачи может любой сотрудник — при
--    необходимости админ урежет право в разделе «Администрирование».
INSERT INTO role_permissions (role, section, can_view, can_edit) VALUES
  ('admin', 'tasks', true, true),
  ('engineer', 'tasks', true, true),
  ('economist', 'tasks', true, true),
  ('lawyer', 'tasks', true, true),
  ('construction_manager', 'tasks', true, true)
ON CONFLICT (role, section) DO NOTHING;
