-- «Заявка на ДП»: подающий заполняет только понятийное соглашение (обязательно), документы и примечание (необязательно), объект, договор,
-- сумму и ответственного заполняет тот, кто работает с заявками (решение пользователя 05.11.2026; раньше всё это обязательно заполнял автор).
--  • колонки объекта, договора, суммы и примечания могут быть пустыми; поданные раньше заявки не меняются;
--  • подача требует только файл понятийного соглашения; «документ договора» стал необязательными документами (категория прежняя: dp_contract_doc);
--  • автор может менять только примечание и свои файлы — поля отдела держит триггер;
--  • заявку без объекта видит и правит работающий с заявками, привязанный к объектам: иначе она не дойдёт до того, кто её заполнит.
--    Автору привязка к объектам подачу не ограничивает: объекта у заявки ещё нет, свою заявку он видит всегда.
-- Триггеры не пересоздаются, поэтому блокировки s3_documents нет. Повтор безопасен. Вариант нового портала — migration/yandex/20261231_dp_requests_short_form.sql.

ALTER TABLE public.dp_requests
  ALTER COLUMN object_id DROP NOT NULL,
  ALTER COLUMN contract_title DROP NOT NULL,
  ALTER COLUMN amount DROP NOT NULL,
  ALTER COLUMN reason DROP NOT NULL;
COMMENT ON TABLE public.dp_requests IS 'Заявка на договор подряда (ДП): подаёт автор (понятийное соглашение, документы, примечание), объект, договор, сумму и ответственного заполняет работающий с заявками. Файлы — s3_documents, owner_type = dp_request';
COMMENT ON COLUMN public.dp_requests.object_id IS 'Объект: заполняет работающий с заявками, у только что поданной заявки пусто';
COMMENT ON COLUMN public.dp_requests.contract_title IS 'Договор текстом: заполняет работающий с заявками; на момент заявки его обычно ещё нет в реестре «Договоры и ДС»';
COMMENT ON COLUMN public.dp_requests.amount IS 'Сумма: заполняет работающий с заявками';
COMMENT ON COLUMN public.dp_requests.reason IS 'Примечание автора, необязательно (до 20261231 — «комментарий: причина создания ДП», обязательный)';

-- ── Запрет и отметки ─────────────────────────────────────────────────────────────────────────────────
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

  NEW.contract_title := nullif(btrim(NEW.contract_title), '');
  NEW.reason := nullif(btrim(NEW.reason), '');
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

    -- Объект, договор, сумму и ответственного заполняет тот, кто работает с заявками: автор не перепишет их поверх уже заполненного
    -- (своей правкой или вкладкой старой версии с полной формой). При создании поля не запрещены: такая вкладка шлёт их сама, вреда нет.
    -- Снять контакт можно: удаление контакта (ON DELETE SET NULL) делает сотрудник без права на этот раздел, ФИО в заявке остаётся.
    IF v_uid IS NOT NULL AND NOT public.osp_can('dp_requests', 'edit')
       AND ((NEW.object_id, NEW.contract_title, NEW.amount, NEW.responsible_name, NEW.responsible_role)
              IS DISTINCT FROM (OLD.object_id, OLD.contract_title, OLD.amount, OLD.responsible_name, OLD.responsible_role)
            OR (NEW.responsible_contact_id IS NOT NULL AND NEW.responsible_contact_id IS DISTINCT FROM OLD.responsible_contact_id)) THEN
      RAISE EXCEPTION 'Объект, договор, сумму и ответственного заполняет сотрудник, работающий с заявками'
        USING ERRCODE = '42501', HINT = 'dp_work_fields';
    END IF;

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

  -- Подача заявки: понятийное соглашение обязательно, база ставит постоянный номер.
  -- Без вошедшего (служебная операция, SQL Editor) — без проверки, как у других запретов.
  IF NEW.status <> 'draft' AND NEW.request_number IS NULL THEN
    IF v_uid IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.s3_documents d
                     WHERE d.owner_type = 'dp_request' AND d.owner_id = NEW.id AND d.doc_category = 'dp_concept_agreement') THEN
        RAISE EXCEPTION 'Заявку на ДП нельзя создать без понятийного соглашения: загрузите его файл'
          USING ERRCODE = 'P0001', HINT = 'dp_concept_agreement_required';
      END IF;
    END IF;
    NEW.request_number := nextval('public.dp_requests_number_seq');
  END IF;
  RETURN NEW;
END
$$;

-- Файлы заявки: добавлять и убирать может тот, кто вправе править заявку; последнее понятийное соглашение поданной заявки не убрать,
-- документы необязательны. Строки s3_documents пишутся под токеном пользователя и через osp-api, и через прежний портал —
-- поэтому граница здесь, а не только в правилах раздела (там нет разницы между своей заявкой и чужой).
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

  IF v_detach AND OLD.doc_category = 'dp_concept_agreement' AND v_status <> 'draft'
     AND NOT EXISTS (SELECT 1 FROM public.s3_documents d
                     WHERE d.owner_type = 'dp_request' AND d.owner_id = v_owner
                       AND d.doc_category = OLD.doc_category AND d.id <> OLD.id) THEN
    RAISE EXCEPTION 'Понятийное соглашение обязательно: сначала загрузите новый файл, затем удалите прежний'
      USING ERRCODE = 'P0001', HINT = 'dp_required_file_last';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

-- ── Права ────────────────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS dp_requests_read ON public.dp_requests;
CREATE POLICY dp_requests_read ON public.dp_requests FOR SELECT TO authenticated
  USING (created_by = (SELECT auth.uid())
         OR (status <> 'draft'
             AND (SELECT public.osp_can('dp_requests', 'view'))
             AND ((SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[])
                  OR (object_id IS NULL AND (SELECT public.osp_can('dp_requests', 'edit'))))));
DROP POLICY IF EXISTS dp_requests_insert ON public.dp_requests;
CREATE POLICY dp_requests_insert ON public.dp_requests FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.osp_can('dp_requests_create', 'edit'))
              AND (object_id IS NULL OR (SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[])));
DROP POLICY IF EXISTS dp_requests_update ON public.dp_requests;
CREATE POLICY dp_requests_update ON public.dp_requests FOR UPDATE TO authenticated
  USING ((status <> 'draft'
          AND (SELECT public.osp_can('dp_requests', 'edit'))
          AND (object_id IS NULL OR (SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[])))
         OR (created_by = (SELECT auth.uid()) AND status IN ('draft', 'new') AND (SELECT public.osp_can('dp_requests_create', 'edit'))))
  WITH CHECK (created_by = (SELECT auth.uid()) OR object_id IS NULL OR (SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[]));
