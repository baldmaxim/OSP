-- «Заявки на проверку ДП/ДС»: руководитель строительства и экономист объекта создают заявки — только в «Новые заявки»
-- (решение пользователя 06.11.2026). Тело supabase/migrations/20270102_doc_check_create.sql, там же зачем и как: те же колонка,
-- триггеры и права ролей, иначе — только права под одну учётку:
--  • служебная функция триггера заявок (SECURITY DEFINER: номер наверх колонки по всем объектам, ФИО автора) — с отметкой
--    пропуска; триггер файлов — с правами вызывающего, как s3_documents_dp_request_guard (20261227);
--  • выдачи ролям Supabase нет. Правила по строкам и список шлюза не меняются.
-- Блокировки — короткие (колонка без значения по умолчанию, триггеры). Данные заявок не меняются. Повтор безопасен.
ALTER TABLE public.doc_check_requests ADD COLUMN IF NOT EXISTS created_by uuid;
COMMENT ON COLUMN public.doc_check_requests.created_by IS
  'Кто создал заявку (учётка): ставит триггер doc_check_requests_write_guard; у заявок до 20270102 — пусто';

CREATE OR REPLACE FUNCTION public.doc_check_requests_write_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row jsonb;
  v_reset jsonb := '{}'::jsonb;
  v_name text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := v_uid;
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.created_by := OLD.created_by;
  END IF;

  IF v_uid IS NULL OR public.osp_can('doc_check_requests', 'edit') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND public.osp_can('doc_check_requests_create', 'edit') THEN
    v_row := to_jsonb(NEW);
    IF NEW.status IS DISTINCT FROM 'new' OR NEW.deleted_at IS NOT NULL OR (v_row ->> 'archived_at') IS NOT NULL THEN
      RAISE EXCEPTION 'Новая заявка встаёт только в «Новые заявки»' USING ERRCODE = '42501', HINT = 'doc_check_create_new_only';
    END IF;
    IF v_row ? 'assignee_ids' THEN v_reset := v_reset || '{"assignee_ids": []}'::jsonb; END IF;
    IF v_row ? 'manual_assignees' THEN v_reset := v_reset || '{"manual_assignees": []}'::jsonb; END IF;
    IF v_row ? 'labels' THEN v_reset := v_reset || '{"labels": []}'::jsonb; END IF;
    IF v_row ? 'due_date' THEN v_reset := v_reset || '{"due_date": null}'::jsonb; END IF;
    IF v_row ? 'priority' THEN v_reset := v_reset || '{"priority": null}'::jsonb; END IF;
    IF v_row ? 'color' THEN v_reset := v_reset || '{"color": null}'::jsonb; END IF;
    NEW := jsonb_populate_record(NEW, v_reset);
    SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), '')) INTO v_name
    FROM public.user_roles ur WHERE ur.user_id = v_uid LIMIT 1;
    NEW.created_by_name := coalesce(v_name, NEW.created_by_name);
    NEW.sort_order := greatest(NEW.sort_order,
      coalesce((SELECT max(r.sort_order) FROM public.doc_check_requests r WHERE r.status = 'new' AND r.deleted_at IS NULL), 0) + 1);
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Менять заявки на проверку ДП/ДС может только сотрудник с правом правки раздела'
    USING ERRCODE = '42501', HINT = 'doc_check_edit_required';
END
$$;
REVOKE ALL ON FUNCTION public.doc_check_requests_write_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS doc_check_requests_write_guard ON public.doc_check_requests;
CREATE TRIGGER doc_check_requests_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.doc_check_requests
  FOR EACH ROW EXECUTE FUNCTION public.doc_check_requests_write_guard();

CREATE OR REPLACE FUNCTION public.s3_documents_doc_check_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_detach boolean := TG_ARGV[0] = 'detach';
  v_owner uuid;
  v_status text;
  v_author uuid;
  v_deleted timestamptz;
BEGIN
  IF auth.uid() IS NULL OR public.osp_can('doc_check_requests', 'edit')
     OR (TG_OP = 'UPDATE' AND v_detach
         AND (NEW.doc_category, NEW.owner_type, NEW.owner_id) IS NOT DISTINCT FROM (OLD.doc_category, OLD.owner_type, OLD.owner_id)) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  v_owner := CASE WHEN v_detach THEN OLD.owner_id ELSE NEW.owner_id END;
  SELECT r.status, r.created_by, r.deleted_at INTO v_status, v_author, v_deleted
  FROM public.doc_check_requests r WHERE r.id = v_owner;
  IF FOUND AND v_author = auth.uid() AND v_status = 'new' AND v_deleted IS NULL
     AND public.osp_can('doc_check_requests_create', 'edit') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Файлы этой заявки на проверку меняет сотрудник с правом правки раздела'
    USING ERRCODE = '42501', HINT = 'doc_check_file_edit';
END
$$;

DROP TRIGGER IF EXISTS s3_documents_doc_check_attach ON public.s3_documents;
CREATE TRIGGER s3_documents_doc_check_attach
  BEFORE INSERT OR UPDATE ON public.s3_documents
  FOR EACH ROW WHEN (NEW.owner_type = 'doc_check_request')
  EXECUTE FUNCTION public.s3_documents_doc_check_guard('attach');
DROP TRIGGER IF EXISTS s3_documents_doc_check_detach ON public.s3_documents;
CREATE TRIGGER s3_documents_doc_check_detach
  BEFORE DELETE OR UPDATE OF doc_category, owner_type, owner_id ON public.s3_documents
  FOR EACH ROW WHEN (OLD.owner_type = 'doc_check_request')
  EXECUTE FUNCTION public.s3_documents_doc_check_guard('detach');

-- Право создания — руководителю строительства и экономисту объекта. Уже выставленное администратором не трогаем.
INSERT INTO public.role_permissions (role, section, can_view, can_edit)
SELECT r.key, 'doc_check_requests_create', true, true
FROM public.roles r
WHERE r.key IN ('construction_manager', 'economist_object')
ON CONFLICT (role, section) DO NOTHING;
