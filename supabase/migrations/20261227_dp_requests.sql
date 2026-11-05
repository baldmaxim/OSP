-- «Заявка на ДП» (решения пользователя 05.11.2026): заявку на договор подряда создают экономист объекта и руководитель
-- строительства, без понятийного соглашения и документа договора её не создать, о новой заявке сразу узнают получатели из списка (большое окно на
-- сайте). Устройство — раздел «Заявка на ДП» в CLAUDE.md, страница — src/pages/DpRequestsPage.jsx.
--
--  • Права — два раздела: dp_requests (просмотр — реестр; правка — работа с заявками: статус, правка и удаление любых) и
--    dp_requests_create (правка — создавать заявки по своим объектам и править свои, пока их не взяли в работу). Кому ещё —
--    галочками в «Правах доступа», новая миграция не нужна. Сотрудник, привязанный к объектам, видит только их заявки.
--  • Заявка рождается черновиком: файл можно загрузить только к существующей строке. Страница пишет черновик, загружает
--    файлы и переводит заявку в 'new'. Запрет — на этом переходе: без файлов dp_concept_agreement и dp_contract_doc заявка в реестр не попадает.
--    Там же база ставит постоянный номер и заводит уведомления получателям. Черновик видит только автор.
--  • Последний файл понятийного соглашения и последний документ договора у поданной заявки удалить нельзя — только заменить
--    (загрузить новый и убрать старый).
--  • Получатели — dp_request_alert_recipients (список ведёт администратор на странице). Начальные — два человека по решению
--    пользователя, по id: ФИО в открытом репозитории не храним. Кого нет в этой базе — пропускается.
--  • Уведомление — строка dp_request_alerts на получателя, читается и гасится только функциями: сведения заявки видны в окне
--    и получателю без права на раздел.
--
-- Только добавление: новые таблицы и два триггера на s3_documents (срабатывают лишь на файлах заявок, WHEN). CREATE TRIGGER
-- на s3_documents берёт короткую блокировку таблицы — применять в нерабочее время. Повтор безопасен.
-- База нового портала (Яндекс) — migration/yandex/20261227_dp_requests.sql.
-- Проверка: migration/backup/checks/20261227.sql; откат — migration/rollback/20261227_dp_requests_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── Таблицы ──────────────────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.dp_requests_number_seq;

CREATE TABLE IF NOT EXISTS public.dp_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number integer,
  object_id uuid NOT NULL REFERENCES public.objects(id) ON DELETE CASCADE,
  contract_title text NOT NULL,
  amount numeric(15, 2) NOT NULL,
  responsible_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  responsible_name text,
  responsible_role text,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  status_changed_at timestamptz,
  status_changed_by_name text,
  created_by uuid,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by_name text,
  CONSTRAINT dp_requests_number_key UNIQUE (request_number),
  CONSTRAINT dp_requests_status_check CHECK (status IN ('draft', 'new', 'in_work', 'completed')),
  CONSTRAINT dp_requests_contract_title_check CHECK (char_length(btrim(contract_title)) BETWEEN 1 AND 500),
  CONSTRAINT dp_requests_amount_check CHECK (amount >= 0),
  CONSTRAINT dp_requests_reason_check CHECK (char_length(btrim(reason)) BETWEEN 1 AND 4000),
  CONSTRAINT dp_requests_responsible_role_check CHECK (responsible_role IS NULL OR responsible_role IN ('economist', 'construction_manager')),
  CONSTRAINT dp_requests_responsible_name_check CHECK (responsible_name IS NULL OR char_length(responsible_name) <= 300)
);
CREATE INDEX IF NOT EXISTS dp_requests_object_idx ON public.dp_requests (object_id);
CREATE INDEX IF NOT EXISTS dp_requests_list_idx ON public.dp_requests (created_at DESC, id DESC);
COMMENT ON TABLE public.dp_requests IS 'Заявка на договор подряда (ДП): объект, договор, сумма, ответственный, причина. Файлы — s3_documents, owner_type = dp_request';
COMMENT ON COLUMN public.dp_requests.request_number IS 'Постоянный номер заявки: ставит база при подаче, не меняется и не переиспользуется; у черновика пусто';
COMMENT ON COLUMN public.dp_requests.contract_title IS 'Договор текстом: на момент заявки его обычно ещё нет в реестре «Договоры и ДС»';
COMMENT ON COLUMN public.dp_requests.responsible_name IS 'Ответственный (экономист объекта или руководитель строительства): ФИО на момент назначения; у контакта его ставит триггер';
COMMENT ON COLUMN public.dp_requests.reason IS 'Комментарий: причина создания ДП';
COMMENT ON COLUMN public.dp_requests.status IS 'draft (идёт загрузка файлов, видит только автор) → new → in_work → completed';

CREATE TABLE IF NOT EXISTS public.dp_request_alert_recipients (
  user_id uuid PRIMARY KEY,
  added_by uuid DEFAULT auth.uid(),
  added_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.dp_request_alert_recipients IS 'Кому при новой заявке на ДП всплывает большое окно. Ведёт администратор на странице заявок';

CREATE TABLE IF NOT EXISTS public.dp_request_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.dp_requests(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT dp_request_alerts_unique UNIQUE (request_id, user_id)
);
CREATE INDEX IF NOT EXISTS dp_request_alerts_unread_idx ON public.dp_request_alerts (user_id, created_at) WHERE read_at IS NULL;
COMMENT ON TABLE public.dp_request_alerts IS 'Уведомление получателю о новой заявке на ДП: заводит триггер, read_at ставит dp_request_alerts_ack, когда человек закрыл окно';

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

DROP TRIGGER IF EXISTS dp_requests_guard ON public.dp_requests;
CREATE TRIGGER dp_requests_guard
  BEFORE INSERT OR UPDATE ON public.dp_requests
  FOR EACH ROW EXECUTE FUNCTION public.dp_requests_guard();

-- Уведомления заводятся один раз — когда заявка подана (из черновика или служебной вставкой сразу поданной).
CREATE OR REPLACE FUNCTION public.dp_requests_alert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'draft' OR (TG_OP = 'UPDATE' AND OLD.status <> 'draft') THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.dp_request_alerts (request_id, user_id)
  SELECT NEW.id, r.user_id FROM public.dp_request_alert_recipients r
  ON CONFLICT (request_id, user_id) DO NOTHING;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS dp_requests_alert ON public.dp_requests;
CREATE TRIGGER dp_requests_alert
  AFTER INSERT OR UPDATE OF status ON public.dp_requests
  FOR EACH ROW EXECUTE FUNCTION public.dp_requests_alert();

-- Файлы заявки: добавлять и убирать может тот, кто вправе править заявку; последнее понятийное соглашение и последний
-- документ договора поданной заявки не убрать. Строки s3_documents пишутся под токеном пользователя и через osp-api, и через прежний портал —
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

DROP TRIGGER IF EXISTS s3_documents_dp_request_attach ON public.s3_documents;
CREATE TRIGGER s3_documents_dp_request_attach
  BEFORE INSERT OR UPDATE OF owner_type, owner_id ON public.s3_documents
  FOR EACH ROW WHEN (NEW.owner_type = 'dp_request')
  EXECUTE FUNCTION public.s3_documents_dp_request_guard('attach');
DROP TRIGGER IF EXISTS s3_documents_dp_request_detach ON public.s3_documents;
CREATE TRIGGER s3_documents_dp_request_detach
  BEFORE DELETE OR UPDATE OF doc_category, owner_type, owner_id ON public.s3_documents
  FOR EACH ROW WHEN (OLD.owner_type = 'dp_request')
  EXECUTE FUNCTION public.s3_documents_dp_request_guard('detach');

-- ── Функции для страницы ─────────────────────────────────────────────────────────────────────────────
-- Объекты вошедшего: NULL — все (администратор или сотрудник без привязки), как scopedObjectIds на странице.
CREATE OR REPLACE FUNCTION public.dp_request_scope() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN public.is_admin() THEN NULL
              ELSE (SELECT nullif(ur.object_ids, '{}'::uuid[]) FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1) END
$$;

-- Непрочитанные уведомления вошедшего со сведениями заявки: окну не нужно право на раздел.
CREATE OR REPLACE FUNCTION public.dp_request_my_alerts()
  RETURNS TABLE (request_id uuid, request_number integer, object_name text, contract_title text, amount numeric,
                 responsible_name text, responsible_role text, reason text, created_by_name text, alerted_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT r.id, r.request_number, o.name::text, r.contract_title, r.amount, r.responsible_name, r.responsible_role, r.reason,
         r.created_by_name, a.created_at
  FROM public.dp_request_alerts a
  JOIN public.dp_requests r ON r.id = a.request_id AND r.deleted_at IS NULL
  LEFT JOIN public.objects o ON o.id = r.object_id
  WHERE a.user_id = auth.uid() AND a.read_at IS NULL AND public.osp_is_employee()
  ORDER BY a.created_at, a.id
  LIMIT 200
$$;

-- Человек закрыл окно: только свои уведомления. → сколько погашено.
CREATE OR REPLACE FUNCTION public.dp_request_alerts_ack(p_requests uuid[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Нужен вход' USING ERRCODE = '42501';
  END IF;
  UPDATE public.dp_request_alerts SET read_at = now()
  WHERE user_id = auth.uid() AND read_at IS NULL AND request_id = ANY (p_requests);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- ── Начальные данные ─────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, section, can_view, can_edit)
SELECT r.key, s.section, s.can_view, s.can_edit
FROM public.roles r
JOIN (VALUES
  ('economist_object', 'dp_requests', true, false),
  ('economist_object', 'dp_requests_create', true, true),
  ('construction_manager', 'dp_requests', true, false),
  ('construction_manager', 'dp_requests_create', true, true),
  ('superuser', 'dp_requests', true, true)
) AS s(role, section, can_view, can_edit) ON s.role = r.key
ON CONFLICT (role, section) DO NOTHING;

-- Получатели по решению пользователя 05.11.2026 (id: ФИО в репозитории не храним). Другие — окном на странице.
INSERT INTO public.dp_request_alert_recipients (user_id, added_by)
SELECT ur.user_id, NULL FROM public.user_roles ur
WHERE ur.user_id IN ('c12b7fec-2ff6-4804-ae8b-604ffcb4c2e8', 'c6e89e48-fa2e-44ce-aae7-54f5d7289e46')
ON CONFLICT (user_id) DO NOTHING;

-- ── Права ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.dp_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dp_requests_read ON public.dp_requests;
CREATE POLICY dp_requests_read ON public.dp_requests FOR SELECT TO authenticated
  USING (created_by = (SELECT auth.uid())
         OR (status <> 'draft'
             AND (SELECT public.osp_can('dp_requests', 'view'))
             AND ((SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[]))));
DROP POLICY IF EXISTS dp_requests_insert ON public.dp_requests;
CREATE POLICY dp_requests_insert ON public.dp_requests FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.osp_can('dp_requests_create', 'edit'))
              AND ((SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[])));
DROP POLICY IF EXISTS dp_requests_update ON public.dp_requests;
CREATE POLICY dp_requests_update ON public.dp_requests FOR UPDATE TO authenticated
  USING ((status <> 'draft'
          AND (SELECT public.osp_can('dp_requests', 'edit'))
          AND ((SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[])))
         OR (created_by = (SELECT auth.uid()) AND status IN ('draft', 'new') AND (SELECT public.osp_can('dp_requests_create', 'edit'))))
  WITH CHECK ((SELECT public.dp_request_scope()) IS NULL OR object_id = ANY ((SELECT public.dp_request_scope())::uuid[]));
DROP POLICY IF EXISTS dp_requests_delete ON public.dp_requests;
CREATE POLICY dp_requests_delete ON public.dp_requests FOR DELETE TO authenticated
  USING (created_by = (SELECT auth.uid()) AND status = 'draft');

ALTER TABLE public.dp_request_alert_recipients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dp_request_alert_recipients_read ON public.dp_request_alert_recipients;
CREATE POLICY dp_request_alert_recipients_read ON public.dp_request_alert_recipients FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT public.osp_can('admin', 'edit')));
DROP POLICY IF EXISTS dp_request_alert_recipients_insert ON public.dp_request_alert_recipients;
CREATE POLICY dp_request_alert_recipients_insert ON public.dp_request_alert_recipients FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.osp_can('admin', 'edit')));
DROP POLICY IF EXISTS dp_request_alert_recipients_delete ON public.dp_request_alert_recipients;
CREATE POLICY dp_request_alert_recipients_delete ON public.dp_request_alert_recipients FOR DELETE TO authenticated
  USING ((SELECT public.osp_can('admin', 'edit')));

-- Уведомления — только функциями: правил для вошедших нет, таблица им не выдана.
ALTER TABLE public.dp_request_alerts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.dp_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dp_requests TO authenticated;
GRANT ALL ON TABLE public.dp_requests TO service_role;
REVOKE ALL ON SEQUENCE public.dp_requests_number_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.dp_requests_number_seq TO authenticated, service_role;
REVOKE ALL ON TABLE public.dp_request_alert_recipients FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.dp_request_alert_recipients TO authenticated;
GRANT ALL ON TABLE public.dp_request_alert_recipients TO service_role;
REVOKE ALL ON TABLE public.dp_request_alerts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.dp_request_alerts TO service_role;

REVOKE ALL ON FUNCTION public.dp_requests_guard() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dp_requests_alert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.s3_documents_dp_request_guard() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dp_request_scope() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dp_request_scope() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.dp_request_my_alerts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dp_request_my_alerts() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.dp_request_alerts_ack(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dp_request_alerts_ack(uuid[]) TO authenticated, service_role;

COMMIT;
