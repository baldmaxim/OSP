-- АВАРИЙНЫЙ ОТКАТ 20261231_dp_requests_short_form (обе базы): снова запреты 20261227 — при подаче нужны документ договора и ответственный, автор правит все поля.
-- Заявки, файлы и примечания не меняются. Обязательность колонок вернётся, только если нет заявок с пустыми объектом, договором, суммой или
-- примечанием: такие заявки сначала заполнить, иначе колонки останутся необязательными (старой странице это не мешает).
-- Страницу откатывать отдельно. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.dp_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text;
BEGIN
  IF v_uid IS NOT NULL THEN
    SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), '')) INTO v_name
    FROM public.user_roles ur WHERE ur.user_id = v_uid LIMIT 1;
  END IF;

  NEW.contract_title := btrim(NEW.contract_title);
  NEW.reason := btrim(NEW.reason);
  NEW.updated_at := now();
  IF NEW.responsible_contact_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.responsible_contact_id IS DISTINCT FROM OLD.responsible_contact_id) THEN
    NEW.responsible_name := coalesce((SELECT nullif(btrim(c.full_name), '') FROM public.contacts c WHERE c.id = NEW.responsible_contact_id),
                                     NEW.responsible_name);
  END IF;
  NEW.responsible_name := nullif(btrim(NEW.responsible_name), '');

  IF TG_OP = 'INSERT' THEN
    IF v_uid IS NOT NULL AND NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Заявка на ДП создаётся черновиком: сначала загружаются файлы' USING ERRCODE = 'P0001';
    END IF;
    NEW.request_number := NULL;
    NEW.created_by := v_uid;
    NEW.created_by_name := v_name;
    NEW.created_at := now();
    NEW.status_changed_at := NULL;
    NEW.status_changed_by_name := NULL;
    NEW.deleted_at := NULL;
    NEW.deleted_by_name := NULL;
  ELSE
    NEW.id := OLD.id;
    NEW.request_number := OLD.request_number;
    NEW.created_by := OLD.created_by;
    NEW.created_by_name := OLD.created_by_name;
    NEW.created_at := OLD.created_at;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status = 'draft' OR (OLD.status = 'draft' AND NEW.status <> 'new') THEN
        RAISE EXCEPTION 'Недопустимая смена статуса заявки на ДП' USING ERRCODE = 'P0001';
      END IF;
      -- Автор сам только подаёт заявку; дальше статус ведёт тот, кто работает с заявками.
      IF v_uid IS NOT NULL AND OLD.status <> 'draft' AND NOT public.osp_can('dp_requests', 'edit') THEN
        RAISE EXCEPTION 'Статус заявки на ДП меняет сотрудник с правом правки раздела' USING ERRCODE = '42501';
      END IF;
      NEW.status_changed_at := now();
      NEW.status_changed_by_name := v_name;
    ELSE
      NEW.status_changed_at := OLD.status_changed_at;
      NEW.status_changed_by_name := OLD.status_changed_by_name;
    END IF;

    IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      IF NEW.deleted_at IS NULL THEN
        NEW.deleted_by_name := NULL;
      ELSE
        NEW.deleted_at := now();
        NEW.deleted_by_name := v_name;
      END IF;
    ELSE
      NEW.deleted_by_name := OLD.deleted_by_name;
    END IF;
  END IF;

  -- Подача заявки: понятийное соглашение, документ договора и ответственный обязательны, база ставит постоянный номер.
  -- Без вошедшего (служебная операция, SQL Editor) — без проверки, как у других запретов.
  IF NEW.status <> 'draft' AND NEW.request_number IS NULL THEN
    IF v_uid IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.s3_documents d
                     WHERE d.owner_type = 'dp_request' AND d.owner_id = NEW.id AND d.doc_category = 'dp_concept_agreement') THEN
        RAISE EXCEPTION 'Заявку на ДП нельзя создать без понятийного соглашения: загрузите его файл'
          USING ERRCODE = 'P0001', HINT = 'dp_concept_agreement_required';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.s3_documents d
                     WHERE d.owner_type = 'dp_request' AND d.owner_id = NEW.id AND d.doc_category = 'dp_contract_doc') THEN
        RAISE EXCEPTION 'Заявку на ДП нельзя создать без документа договора: загрузите его файл'
          USING ERRCODE = 'P0001', HINT = 'dp_contract_doc_required';
      END IF;
      IF NEW.responsible_name IS NULL THEN
        RAISE EXCEPTION 'Укажите ответственного: экономиста объекта или руководителя строительства'
          USING ERRCODE = 'P0001', HINT = 'dp_responsible_required';
      END IF;
    END IF;
    NEW.request_number := nextval('public.dp_requests_number_seq');
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.s3_documents_dp_request_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_detach boolean := TG_ARGV[0] = 'detach';
  v_owner uuid;
  v_status text;
  v_author uuid;
BEGIN
  IF auth.uid() IS NULL
     OR (TG_OP = 'UPDATE' AND v_detach
         AND (NEW.doc_category, NEW.owner_type, NEW.owner_id) IS NOT DISTINCT FROM (OLD.doc_category, OLD.owner_type, OLD.owner_id)) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  v_owner := CASE WHEN v_detach THEN OLD.owner_id ELSE NEW.owner_id END;
  SELECT r.status, r.created_by INTO v_status, v_author FROM public.dp_requests r WHERE r.id = v_owner;
  IF NOT FOUND THEN
    -- Заявки уже нет: её файл можно убрать; добавить файл к несуществующей — нельзя.
    IF v_detach THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Заявка на ДП не найдена' USING ERRCODE = '42501';
  END IF;

  IF NOT (public.osp_can('dp_requests', 'edit')
          OR (v_author = auth.uid() AND v_status IN ('draft', 'new') AND public.osp_can('dp_requests_create', 'edit'))) THEN
    RAISE EXCEPTION 'Нет права менять файлы этой заявки на ДП' USING ERRCODE = '42501';
  END IF;

  IF v_detach AND OLD.doc_category IN ('dp_concept_agreement', 'dp_contract_doc') AND v_status <> 'draft'
     AND NOT EXISTS (SELECT 1 FROM public.s3_documents d
                     WHERE d.owner_type = 'dp_request' AND d.owner_id = v_owner
                       AND d.doc_category = OLD.doc_category AND d.id <> OLD.id) THEN
    RAISE EXCEPTION '%: сначала загрузите новый файл, затем удалите прежний',
      CASE WHEN OLD.doc_category = 'dp_concept_agreement' THEN 'Понятийное соглашение обязательно' ELSE 'Документ договора обязателен' END
      USING ERRCODE = 'P0001', HINT = 'dp_required_file_last';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF to_regprocedure('osp_private.bypass()') IS NOT NULL THEN
    EXECUTE $pol$DROP POLICY IF EXISTS dp_requests_read ON public.dp_requests$pol$;
    EXECUTE $pol$CREATE POLICY dp_requests_read ON public.dp_requests FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated'))
                    AND (created_by = (SELECT auth.uid())
                         OR (status <> 'draft'
                             AND (SELECT public.osp_can('dp_requests', 'view'))
                             AND ((SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[]))))) END)$pol$;
    EXECUTE $pol$DROP POLICY IF EXISTS dp_requests_insert ON public.dp_requests$pol$;
    EXECUTE $pol$CREATE POLICY dp_requests_insert ON public.dp_requests FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated'))
                         AND (SELECT public.osp_can('dp_requests_create', 'edit'))
                         AND ((SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[]))) END)$pol$;
    EXECUTE $pol$DROP POLICY IF EXISTS dp_requests_update ON public.dp_requests$pol$;
    EXECUTE $pol$CREATE POLICY dp_requests_update ON public.dp_requests FOR UPDATE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated'))
                    AND ((status <> 'draft'
                          AND (SELECT public.osp_can('dp_requests', 'edit'))
                          AND ((SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[])))
                         OR (created_by = (SELECT auth.uid()) AND status IN ('draft', 'new') AND (SELECT public.osp_can('dp_requests_create', 'edit'))))) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated'))
                         AND ((SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[]))) END)$pol$;
  ELSE
    EXECUTE $pol$DROP POLICY IF EXISTS dp_requests_read ON public.dp_requests$pol$;
    EXECUTE $pol$CREATE POLICY dp_requests_read ON public.dp_requests FOR SELECT TO authenticated
  USING (created_by = (SELECT auth.uid())
         OR (status <> 'draft'
             AND (SELECT public.osp_can('dp_requests', 'view'))
             AND ((SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[]))))$pol$;
    EXECUTE $pol$DROP POLICY IF EXISTS dp_requests_insert ON public.dp_requests$pol$;
    EXECUTE $pol$CREATE POLICY dp_requests_insert ON public.dp_requests FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.osp_can('dp_requests_create', 'edit'))
              AND ((SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[])))$pol$;
    EXECUTE $pol$DROP POLICY IF EXISTS dp_requests_update ON public.dp_requests$pol$;
    EXECUTE $pol$CREATE POLICY dp_requests_update ON public.dp_requests FOR UPDATE TO authenticated
  USING ((status <> 'draft'
          AND (SELECT public.osp_can('dp_requests', 'edit'))
          AND ((SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[])))
         OR (created_by = (SELECT auth.uid()) AND status IN ('draft', 'new') AND (SELECT public.osp_can('dp_requests_create', 'edit'))))
  WITH CHECK ((SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[]))$pol$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.dp_requests WHERE object_id IS NULL OR contract_title IS NULL OR amount IS NULL OR reason IS NULL) THEN
    ALTER TABLE public.dp_requests
      ALTER COLUMN object_id SET NOT NULL,
      ALTER COLUMN contract_title SET NOT NULL,
      ALTER COLUMN amount SET NOT NULL,
      ALTER COLUMN reason SET NOT NULL;
  END IF;
END
$$;

COMMENT ON COLUMN public.dp_requests.reason IS 'Комментарий: причина создания ДП';

COMMIT;
