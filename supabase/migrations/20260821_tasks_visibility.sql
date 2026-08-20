-- Задачи: сотрудник видит только свои.
--
-- Проблема. Политики из 20260818_tasks_foundation.sql разрешают FOR ALL любому,
-- кто проходит is_negotiation_employee() — то есть каждый подтверждённый
-- сотрудник читает и правит ВСЕ задачи компании, включая чужую переписку,
-- чек-листы и вложения.
--
-- Решение. Задача видна, если текущий пользователь:
--   • администратор (is_admin() из 20260617), либо
--   • исполнитель (assignee_user_id), либо
--   • постановщик (created_by_user_id), либо
--   • участник — соисполнитель или наблюдатель (task_participants).
--
-- Постановщик и наблюдатель в списке не случайно: приёмку работы («На проверке»
-- → «Завершена») делает именно постановщик, а роль наблюдателя без права видеть
-- задачу теряет смысл.
--
-- Требует применённых 20260818 (таблицы задач), 20260815 (is_negotiation_employee)
-- и 20260617 (is_admin). Миграция идемпотентна.

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Хелперы.
--
-- SECURITY DEFINER здесь обязателен: политика на tasks спрашивает
-- task_participants, а политика на task_participants — tasks. Без обхода RLS
-- внутри функций это зациклилось бы.

-- Текущий пользователь — участник задачи (соисполнитель или наблюдатель).
CREATE OR REPLACE FUNCTION public.is_task_participant(task_uuid uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM task_participants tp
    WHERE tp.task_id = task_uuid AND tp.user_id = auth.uid()
  );
$$;
REVOKE ALL ON FUNCTION public.is_task_participant(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_task_participant(uuid) TO authenticated;

-- Видимость задачи целиком — для дочерних таблиц и вложений.
CREATE OR REPLACE FUNCTION public.can_see_task(task_uuid uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT public.is_admin()
      OR EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.id = task_uuid
          AND (t.assignee_user_id = auth.uid() OR t.created_by_user_id = auth.uid())
      )
      OR public.is_task_participant(task_uuid);
$$;
REVOKE ALL ON FUNCTION public.can_see_task(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.can_see_task(uuid) TO authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Индексы под новые предикаты.
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_user_id ON tasks(assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_by_user_id ON tasks(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_task_participants_user_task ON task_participants(user_id, task_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Политики на tasks.
--
-- Прежняя FOR ALL разбита по операциям: при INSERT строки ещё нет, и общий
-- WITH CHECK с предикатом видимости отбивал бы создание задачи.
--
-- Предикат по колонкам самой строки пишем инлайном, а не через can_see_task(id),
-- чтобы планировщик мог воспользоваться индексами выше.
DROP POLICY IF EXISTS tasks_employee_all ON tasks;
DROP POLICY IF EXISTS tasks_select_visible ON tasks;
DROP POLICY IF EXISTS tasks_insert_employee ON tasks;
DROP POLICY IF EXISTS tasks_update_visible ON tasks;
DROP POLICY IF EXISTS tasks_delete_visible ON tasks;

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

-- Ставить задачи может любой сотрудник, но только от своего имени.
CREATE POLICY tasks_insert_employee ON tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_negotiation_employee()
    AND (public.is_admin() OR created_by_user_id = auth.uid())
  );

-- Править можно то, что видишь. WITH CHECK намеренно мягче USING: иначе
-- исполнитель не смог бы передать задачу коллеге — после смены исполнителя
-- строка перестаёт быть видимой ему самому, и строгая проверка отбила бы UPDATE
-- сырой ошибкой Postgres. Доступ на чтение это не расширяет: USING по-прежнему
-- пускает к строке только её участников.
CREATE POLICY tasks_update_visible ON tasks
  FOR UPDATE TO authenticated
  USING (
    public.is_negotiation_employee() AND (
      public.is_admin()
      OR assignee_user_id = auth.uid()
      OR created_by_user_id = auth.uid()
      OR public.is_task_participant(id)
    )
  )
  WITH CHECK (public.is_negotiation_employee());

CREATE POLICY tasks_delete_visible ON tasks
  FOR DELETE TO authenticated
  USING (
    public.is_negotiation_employee() AND (
      public.is_admin()
      OR assignee_user_id = auth.uid()
      OR created_by_user_id = auth.uid()
      OR public.is_task_participant(id)
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Дочерние таблицы — доступны ровно там, где видна сама задача.
DROP POLICY IF EXISTS task_participants_employee_all ON task_participants;
DROP POLICY IF EXISTS task_checklist_employee_all ON task_checklist_items;
DROP POLICY IF EXISTS task_comments_employee_all ON task_comments;
DROP POLICY IF EXISTS task_audit_log_employee_all ON task_audit_log;

DROP POLICY IF EXISTS task_participants_visible ON task_participants;
CREATE POLICY task_participants_visible ON task_participants
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee() AND public.can_see_task(task_id))
  WITH CHECK (public.is_negotiation_employee() AND public.can_see_task(task_id));

DROP POLICY IF EXISTS task_checklist_visible ON task_checklist_items;
CREATE POLICY task_checklist_visible ON task_checklist_items
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee() AND public.can_see_task(task_id))
  WITH CHECK (public.is_negotiation_employee() AND public.can_see_task(task_id));

DROP POLICY IF EXISTS task_comments_visible ON task_comments;
CREATE POLICY task_comments_visible ON task_comments
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee() AND public.can_see_task(task_id))
  WITH CHECK (public.is_negotiation_employee() AND public.can_see_task(task_id));

DROP POLICY IF EXISTS task_audit_log_visible ON task_audit_log;
CREATE POLICY task_audit_log_visible ON task_audit_log
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee() AND public.can_see_task(task_id))
  WITH CHECK (public.is_negotiation_employee() AND public.can_see_task(task_id));

-- ────────────────────────────────────────────────────────────────────────────
-- 5) Вложения задач.
--
-- s3_documents — общая таблица всех разделов с политикой USING (true), поэтому
-- файлы чужой задачи оставались бы доступны по API. Условие короткозамыкается:
-- для owner_type <> 'task' поведение не меняется вовсе.
DROP POLICY IF EXISTS "Allow all for authenticated users" ON s3_documents;
DROP POLICY IF EXISTS s3_documents_authenticated ON s3_documents;
CREATE POLICY s3_documents_authenticated ON s3_documents
  FOR ALL TO authenticated
  USING (owner_type <> 'task' OR public.can_see_task(owner_id))
  WITH CHECK (owner_type <> 'task' OR public.can_see_task(owner_id));
