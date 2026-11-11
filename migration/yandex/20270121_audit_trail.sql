-- Журналы действий (только база Яндекса).
--
-- 1. Достоверный журнал — от базы: osp_private.data_audit_log. Строку пишет триггер самой бизнес-таблицы (договоры, тендеры,
--    контрагенты, заявки на ДС, заявки на проверку ДП/ДС, задачи) в той же транзакции, что и изменение: обойти запись, подменить
--    событие, автора или время нельзя. Внешних ключей нет — запись переживает удаление строки. Закрытая схема: через PostgREST
--    её не видно, правил для пользователей нет (только служебные операции). Читает администратор (SQL).
--      UPDATE — только изменившиеся колонки {колонка: [было, стало]} без служебных (updated_at, row_version); пустое — не пишется;
--      INSERT / DELETE — вся строка. Автор — из токена (auth.uid(), ФИО и роль из user_roles); без пользователя — имя программы
--      (служебная операция, миграция, скрипт).
-- 2. Журналы для экрана (contract_ / tender_ / counterparty_ / dc_request_ / doc_check_request_ / task_audit_log) пишет браузер
--    штатными действиями; теперь:
--      • автор, роль и время ставит сервер (BEFORE INSERT): прислать чужое имя, роль предпросмотра или дату нельзя;
--        changed_by — id автора (новая колонка);
--      • исправить запись нельзя (BEFORE UPDATE — отказ 42501); удалить — только вместе со строкой-родителем (каскад: родителя
--        к этому моменту уже нет), факт удаления родителя хранит data_audit_log. Служебные операции (пропуск) — как раньше.
--    Шлюз (server/osp-api/src/data/db-sections.json) их update / delete и не пропускает.
-- Фронт не меняется.

-- ── 1. Журнал базы ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS osp_private.data_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  table_name text NOT NULL,
  row_id uuid,
  op text NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
  actor uuid,
  actor_name text,
  actor_role text,
  changes jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS data_audit_log_row_idx ON osp_private.data_audit_log (table_name, row_id, at);
CREATE INDEX IF NOT EXISTS data_audit_log_at_idx ON osp_private.data_audit_log (at);
CREATE INDEX IF NOT EXISTS data_audit_log_actor_idx ON osp_private.data_audit_log (actor, at);
COMMENT ON TABLE osp_private.data_audit_log IS 'Журнал изменений бизнес-таблиц от базы (триггер): кто, когда, что было и стало; переживает удаление строки';

ALTER TABLE osp_private.data_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE osp_private.data_audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osp_internal ON osp_private.data_audit_log;
CREATE POLICY osp_internal ON osp_private.data_audit_log FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Запись — служебной операцией: таблица открыта только пропуску. Автора и программу передаёт триггер (вызывающая сторона).
CREATE OR REPLACE FUNCTION osp_private.data_audit_write(p_table text, p_row uuid, p_op text, p_actor uuid, p_program text,
                                                        p_changes jsonb) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_name text;
  v_role text;
BEGIN
  IF p_actor IS NOT NULL THEN
    SELECT nullif(btrim(ur.full_name), ''), ur.role INTO v_name, v_role FROM public.user_roles ur WHERE ur.user_id = p_actor LIMIT 1;
  END IF;
  INSERT INTO osp_private.data_audit_log (table_name, row_id, op, actor, actor_name, actor_role, changes)
  VALUES (p_table, p_row, p_op, p_actor,
          CASE WHEN p_actor IS NULL THEN 'служебная операция: ' || coalesce(nullif(p_program, ''), 'без имени') ELSE v_name END,
          v_role, p_changes);
END
$$;

-- Триггер бизнес-таблицы: работает в контексте вызывающего — так видно его токен и имя программы.
CREATE OR REPLACE FUNCTION osp_private.data_audit_row() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_changes jsonb;
  v_row uuid;
  v_skip text[] := ARRAY['updated_at', 'row_version'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value)) INTO v_changes
      FROM jsonb_each(to_jsonb(NEW)) n
      JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
     WHERE n.value IS DISTINCT FROM o.value AND NOT (n.key = ANY (v_skip));
    IF v_changes IS NULL THEN RETURN NULL; END IF;
    v_row := NEW.id;
  ELSIF TG_OP = 'INSERT' THEN
    v_changes := to_jsonb(NEW);
    v_row := NEW.id;
  ELSE
    v_changes := to_jsonb(OLD);
    v_row := OLD.id;
  END IF;
  PERFORM osp_private.data_audit_write(TG_TABLE_NAME, v_row, TG_OP, auth.uid(),
                                       current_setting('application_name', true), v_changes);
  RETURN NULL;
END
$$;

DO $data_audit$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contracts', 'tenders', 'counterparties', 'dc_requests', 'doc_check_requests', 'tasks'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS osp_data_audit ON public.%I', t);
    EXECUTE format('CREATE TRIGGER osp_data_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION osp_private.data_audit_row()', t);
  END LOOP;
END
$data_audit$;

-- ── 2. Журналы для экрана ────────────────────────────────────────────────────
DO $audit_cols$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contract_audit_log', 'tender_audit_log', 'counterparty_audit_log', 'dc_request_audit_log',
                           'doc_check_request_audit_log', 'task_audit_log'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS changed_by uuid', t);
  END LOOP;
END
$audit_cols$;

-- Автор, роль и время — от сервера. Без пользователя (служебная операция, миграция) — как прислали.
CREATE OR REPLACE FUNCTION public.audit_log_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  a record;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO a FROM public.psdc_actor();
  NEW.changed_by := auth.uid();
  NEW.changed_at := now();
  NEW.changed_by_name := coalesce(nullif(btrim(a.full_name), ''), nullif(auth.email(), ''), 'Пользователь');
  NEW.changed_by_role := a.role;
  RETURN NEW;
END
$$;

-- Есть ли ещё строка-родитель (с пропуском: скрытая от пользователя тоже считается). Имена таблиц — только из списка.
CREATE OR REPLACE FUNCTION public.audit_log_parent_exists(p_table text, p_id uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  RETURN CASE p_table
    WHEN 'contract_audit_log' THEN EXISTS (SELECT 1 FROM public.contracts WHERE id = p_id)
    WHEN 'tender_audit_log' THEN EXISTS (SELECT 1 FROM public.tenders WHERE id = p_id)
    WHEN 'counterparty_audit_log' THEN EXISTS (SELECT 1 FROM public.counterparties WHERE id = p_id)
    WHEN 'dc_request_audit_log' THEN EXISTS (SELECT 1 FROM public.dc_requests WHERE id = p_id)
    WHEN 'doc_check_request_audit_log' THEN EXISTS (SELECT 1 FROM public.doc_check_requests WHERE id = p_id)
    WHEN 'task_audit_log' THEN EXISTS (SELECT 1 FROM public.tasks WHERE id = p_id)
    ELSE true
  END;
END
$$;

-- Исправлять запись нельзя; удалять — только вместе с родителем. Служебные операции (пропуск) и скрипты без пользователя — можно.
CREATE OR REPLACE FUNCTION public.audit_log_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_parent uuid;
BEGIN
  IF auth.uid() IS NULL OR (SELECT osp_private.bypass()) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Запись истории изменить нельзя' USING ERRCODE = '42501', HINT = 'audit_log_immutable';
  END IF;
  v_parent := (to_jsonb(OLD) ->> TG_ARGV[0])::uuid;
  IF public.audit_log_parent_exists(TG_TABLE_NAME, v_parent) THEN
    RAISE EXCEPTION 'Запись истории удалить нельзя' USING ERRCODE = '42501', HINT = 'audit_log_immutable';
  END IF;
  RETURN OLD;
END
$$;

DO $audit_triggers$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('contract_audit_log', 'contract_id'), ('tender_audit_log', 'tender_id'),
                                 ('counterparty_audit_log', 'counterparty_id'), ('dc_request_audit_log', 'dc_request_id'),
                                 ('doc_check_request_audit_log', 'request_id'), ('task_audit_log', 'task_id')) v(t, parent) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_log_stamp ON public.%I', r.t);
    EXECUTE format('CREATE TRIGGER audit_log_stamp BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.audit_log_stamp()', r.t);
    EXECUTE format('DROP TRIGGER IF EXISTS audit_log_guard ON public.%I', r.t);
    EXECUTE format('CREATE TRIGGER audit_log_guard BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.audit_log_guard(%L)',
                   r.t, r.parent);
  END LOOP;
END
$audit_triggers$;
