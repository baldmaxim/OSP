-- «Реестр по договорам»: юрист — только действующий юрист ОСП, исполнитель «Заключения ДП» переходит в договор, договор появляется
-- сразу при подаче заявки (решение пользователя 23.11.2026). Подробно — в базе нового портала:
-- migration/yandex/20270226_registry_osp_lawyers.sql. Тело то же; здесь — права функций для ролей Supabase и перечитывание схемы
-- PostgREST. Нужна 20270225. Повтор безопасен: перенос юристов и дописка договоров — только раз.
-- Проверка: migration/backup/checks/20270226.sql, откат — migration/rollback/20270226_registry_osp_lawyers_rollback.sql.
-- Применять в нерабочее время: ALTER TABLE ненадолго блокирует договоры.

BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regprocedure('public.dp_conclusion_contract_create(uuid, text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contracts'
                    AND column_name = 'doc_check_request_id') THEN
    RAISE EXCEPTION 'Нет договоров из «Заключения ДП»: сначала 20270225_dp_conclusion_registry_contract';
  END IF;
END
$$;

-- ── Действующий юрист ОСП ─────────────────────────────────────────────────────────────────────────────
-- То же правило, что у исполнителей доски ДП/ДС (utils/docCheckHelpers.js, справочник employee_directory): роль lawyer,
-- учётка подтверждена (блокировка снимает подтверждение), не подрядчик. Служебные: страница и шлюз их не вызывают.
CREATE OR REPLACE FUNCTION public.osp_is_active_lawyer(p_user uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = p_user AND ur.role = 'lawyer' AND ur.is_approved AND ur.counterparty_id IS NULL)
$$;

-- Первый действующий юрист ОСП в списке (исполнители заявки — в их порядке) или NULL.
CREATE OR REPLACE FUNCTION public.osp_first_lawyer(p_users uuid[]) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT a.u FROM unnest(coalesce(p_users, '{}'::uuid[])) WITH ORDINALITY AS a(u, n)
  WHERE public.osp_is_active_lawyer(a.u)
  ORDER BY a.n
  LIMIT 1
$$;

-- ФИО учётки для «Истории» (NULL — нет такой).
CREATE OR REPLACE FUNCTION public.osp_user_display_name(p_user uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), '')) FROM public.user_roles ur WHERE ur.user_id = p_user LIMIT 1
$$;

-- Действующие юристы ОСП для выбора и показа юриста: реестр договоров, карточка договора, импорт, отчёт по юристам. Справочник
-- сотрудников (employee_directory) шлюз отдаёт не всем, кто видит договоры (у роли сметного отдела его нет), — поэтому отдельная
-- узкая функция, как list_sto_employees: только id и ФИО юристов, только сотруднику портала. В шлюзе — праву «Договоры» или «Отчёты».
CREATE OR REPLACE FUNCTION public.list_osp_lawyers()
  RETURNS TABLE (user_id uuid, display_name text, full_name text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT ur.user_id, coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), ''), 'Юрист ОСП')::text,
         ur.full_name::text, ur.role::text
  FROM public.user_roles ur
  WHERE ur.role = 'lawyer' AND ur.is_approved AND ur.counterparty_id IS NULL AND public.osp_is_employee()
  ORDER BY 2, 1
$$;

-- ── 1. Юрист договора — учётка ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_first boolean := NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contracts'
                                 AND column_name = 'responsible_user_id');
  v_moved integer := 0;
  v_left integer := 0;
BEGIN
  ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS responsible_user_id uuid;
  IF NOT v_first THEN
    RETURN;
  END IF;

  -- Контакт → действующий юрист: ФИО без регистра, «ё» = «е», пробелы сжаты; полностью или началом по словам.
  WITH law AS (
    SELECT ur.user_id, lower(regexp_replace(btrim(translate(ur.full_name, 'Ёё', 'Ее')), '\s+', ' ', 'g')) AS nm
    FROM public.user_roles ur
    WHERE ur.role = 'lawyer' AND ur.is_approved AND ur.counterparty_id IS NULL AND nullif(btrim(ur.full_name), '') IS NOT NULL
  ), ct AS (
    SELECT c.id, lower(regexp_replace(btrim(translate(c.full_name, 'Ёё', 'Ее')), '\s+', ' ', 'g')) AS nm
    FROM public.contacts c
    WHERE nullif(btrim(c.full_name), '') IS NOT NULL
  ), one AS (
    SELECT ct.id AS contact_id, (array_agg(DISTINCT law.user_id))[1] AS user_id
    FROM ct JOIN law ON law.nm = ct.nm OR left(law.nm, length(ct.nm) + 1) = ct.nm || ' ' OR left(ct.nm, length(law.nm) + 1) = law.nm || ' '
    GROUP BY ct.id
    HAVING count(DISTINCT law.user_id) = 1
  )
  UPDATE public.contracts k SET responsible_user_id = one.user_id
  FROM one WHERE k.responsible_contact_id = one.contact_id;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  -- Не перенесённые — след в «Истории»: почему юриста в реестре больше нет.
  INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
  SELECT k.id, 'field_updated', 'responsible_user_id', to_jsonb(c.full_name::text), NULL,
         'Ответственный юрист «' || coalesce(nullif(btrim(c.full_name), ''), '—')
           || '» снят: в реестре остаются только действующие юристы ОСП (учётка заблокирована, другая роль или не найдена)',
         'Автоматически'
  FROM public.contracts k JOIN public.contacts c ON c.id = k.responsible_contact_id
  WHERE k.responsible_user_id IS NULL;
  GET DIAGNOSTICS v_left = ROW_COUNT;

  -- Договоры из заявок «Заключение ДП» без юриста — исполнитель заявки.
  UPDATE public.contracts k SET responsible_user_id = public.osp_first_lawyer(r.assignee_ids)
  FROM public.doc_check_requests r
  WHERE k.doc_check_request_id = r.id AND k.responsible_user_id IS NULL AND public.osp_first_lawyer(r.assignee_ids) IS NOT NULL;

  RAISE NOTICE 'Ответственный юрист договоров: перенесено на учётку юриста ОСП %, снято (не действующий юрист ОСП) %', v_moved, v_left;
END
$$;
CREATE INDEX IF NOT EXISTS contracts_responsible_user_idx ON public.contracts (responsible_user_id) WHERE responsible_user_id IS NOT NULL;
COMMENT ON COLUMN public.contracts.responsible_user_id IS
  'Ответственный юрист — учётка действующего юриста ОСП (с 20270226; проверка — contracts_lawyer_guard); responsible_contact_id — прежнее значение из «Сотрудников», реестр его не показывает';

-- ── 2. Назначить можно только действующего юриста ОСП ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.contracts_lawyer_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NEW.responsible_user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.responsible_user_id IS DISTINCT FROM OLD.responsible_user_id)
     AND NOT public.osp_is_active_lawyer(NEW.responsible_user_id) THEN
    RAISE EXCEPTION 'Ответственным юристом можно назначить только действующего юриста ОСП' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS contracts_lawyer_guard ON public.contracts;
CREATE TRIGGER contracts_lawyer_guard
  BEFORE INSERT OR UPDATE OF responsible_user_id ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.contracts_lawyer_guard();

-- ── 3. Договор из «Заключения ДП» — сразу при подаче ──────────────────────────────────────────────────
-- Заявка в «Новых» — «Новая заявка» без даты «Принят в работу»; дальше — «В работе», «Принят в работу» — сегодня по Москве.
-- Юрист — первый действующий юрист ОСП среди исполнителей. Объект, контрагент, тендер, номер, примечание — как в 20270225.
-- Заявки не того типа, удалённые или уже с договором — ничего. → id созданного договора или NULL.
CREATE OR REPLACE FUNCTION public.dp_conclusion_contract_create(p_request uuid, p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  r public.doc_check_requests%ROWTYPE;
  v_number text;
  v_tender uuid;
  v_new boolean;
  v_lawyer uuid;
  v_id uuid;
  v_display bigint;
  v_name text;
  v_role text;
BEGIN
  SELECT * INTO r FROM public.doc_check_requests WHERE id = p_request;
  IF NOT FOUND OR r.doc_type IS DISTINCT FROM 'dp_conclusion' OR r.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.contracts c WHERE c.doc_check_request_id = r.id) THEN RETURN NULL; END IF;

  v_number := coalesce(to_jsonb(r) ->> 'request_number', '—');
  v_tender := (to_jsonb(r) ->> 'tender_id')::uuid;
  v_new := r.status = 'new';
  v_lawyer := public.osp_first_lawyer(r.assignee_ids);

  INSERT INTO public.contracts (record_type, status, object_id, counterparty_id, tender_id, accepted_date, notes, doc_check_request_id,
                                responsible_user_id)
  VALUES ('dp', CASE WHEN v_new THEN 'new_request' ELSE 'in_work' END, r.object_id, r.counterparty_id, v_tender,
          CASE WHEN v_new THEN NULL ELSE (now() AT TIME ZONE 'Europe/Moscow')::date END,
          concat_ws(E'\n', 'Из заявки «Заключение ДП» ID ' || v_number, nullif(btrim(r.notes), '')), r.id, v_lawyer)
  ON CONFLICT (doc_check_request_id) WHERE doc_check_request_id IS NOT NULL DO NOTHING
  RETURNING id, display_id INTO v_id, v_display;
  IF v_id IS NULL THEN RETURN NULL; END IF;

  IF r.counterparty_id IS NOT NULL THEN
    INSERT INTO public.contract_counterparties (contract_id, counterparty_id, sort_order)
    VALUES (v_id, r.counterparty_id, 0)
    ON CONFLICT (contract_id, counterparty_id) DO NOTHING;
  END IF;

  -- Кто подал или перевёл заявку (у выкладки — никто).
  SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), '')), ur.role INTO v_name, v_role
  FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;

  INSERT INTO public.contract_audit_log (contract_id, event_type, new_value, description, changed_by_role, changed_by_name)
  VALUES (v_id, 'created', jsonb_build_object('doc_check_request_id', r.id, 'request_number', v_number, 'responsible_user_id', v_lawyer),
          'Создан договор (без номера) ' || p_reason
            || coalesce('; ответственный юрист — ' || public.osp_user_display_name(v_lawyer) || ' (исполнитель заявки)', ''),
          v_role, v_name);

  INSERT INTO public.doc_check_request_audit_log
    (request_id, event_type, field_name, new_value, description, changed_at, changed_by_role, changed_by_name)
  VALUES (r.id, 'contract_created', NULL, jsonb_build_object('contract_id', v_id, 'display_id', v_display),
          'Договор создан в «Реестре по договорам»: ID ' || v_display, now(), v_role, coalesce(v_name, 'Автоматически'));
  RETURN v_id;
END
$$;

-- Заявка «Заключение ДП»: подана (или стала «Заключением ДП», или восстановлена без договора) — договор; ушла из «Новых» — договор
-- из «Новой заявки» в «В работе»; удалена, пока договор «Новая заявка», — договор в «Удалённые», восстановлена — обратно; сменили
-- исполнителей — юрист договора следует за ними, если в реестре его не меняли. Возврат карточки в «Новые» договор не трогает.
-- Заявке, пропущенной при выкладке (похожий договор уже внесён вручную), смена колонки договора не создаёт.
CREATE OR REPLACE FUNCTION public.doc_check_dp_conclusion_contract() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  k public.contracts%ROWTYPE;
  v_num text := coalesce(to_jsonb(NEW) ->> 'request_number', '—');
  v_name text;
  v_role text;
  v_lawyer uuid;
  v_last record;
BEGIN
  SELECT * INTO k FROM public.contracts c WHERE c.doc_check_request_id = NEW.id;
  IF NOT FOUND THEN
    IF NEW.deleted_at IS NULL AND (TG_OP = 'INSERT' OR NEW.doc_type IS DISTINCT FROM OLD.doc_type OR OLD.deleted_at IS NOT NULL) THEN
      PERFORM public.dp_conclusion_contract_create(NEW.id, 'автоматически: '
        || CASE WHEN TG_OP = 'INSERT' THEN 'подана' ELSE 'на доске' END || ' заявка «Заключение ДП» ID ' || v_num);
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NULL; END IF;

  SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), '')), ur.role INTO v_name, v_role
  FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;
  v_name := coalesce(v_name, 'Автоматически');

  -- Заявку удалили: договор, с которым ещё не начинали работать («Новая заявка»), — в «Удалённые».
  IF NEW.deleted_at IS NOT NULL THEN
    IF OLD.deleted_at IS NULL AND k.deleted_at IS NULL AND k.status = 'new_request' THEN
      UPDATE public.contracts SET deleted_at = now() WHERE id = k.id;
      INSERT INTO public.contract_audit_log (contract_id, event_type, new_value, description, changed_by_role, changed_by_name)
      VALUES (k.id, 'soft_deleted', jsonb_build_object('doc_check_request_deleted', NEW.id),
              'Договор перенесён в «Удалённые»: заявка «Заключение ДП» ID ' || v_num || ' удалена на доске', v_role, v_name);
    END IF;
    RETURN NULL;
  END IF;

  -- Заявку восстановили: договор возвращается, если в «Удалённые» его унесло удаление заявки и с тех пор его не трогали.
  IF OLD.deleted_at IS NOT NULL AND k.deleted_at IS NOT NULL THEN
    SELECT l.event_type, l.new_value INTO v_last FROM public.contract_audit_log l
    WHERE l.contract_id = k.id ORDER BY l.changed_at DESC, l.id DESC LIMIT 1;
    IF v_last.event_type = 'soft_deleted' AND v_last.new_value ? 'doc_check_request_deleted' THEN
      UPDATE public.contracts SET deleted_at = NULL WHERE id = k.id;
      k.deleted_at := NULL;
      INSERT INTO public.contract_audit_log (contract_id, event_type, description, changed_by_role, changed_by_name)
      VALUES (k.id, 'restored', 'Договор восстановлен: заявка «Заключение ДП» ID ' || v_num || ' восстановлена на доске', v_role, v_name);
    END IF;
  END IF;
  IF k.deleted_at IS NOT NULL THEN RETURN NULL; END IF;

  -- Заявка ушла из «Новых»: договор «Новая заявка» → «В работе», «Принят в работу» — сегодня, если не стоит.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'new' AND k.status = 'new_request' THEN
    UPDATE public.contracts SET status = 'in_work', accepted_date = coalesce(accepted_date, (now() AT TIME ZONE 'Europe/Moscow')::date)
    WHERE id = k.id;
    INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_role, changed_by_name)
    VALUES (k.id, 'status_changed', 'status', to_jsonb('new_request'::text), to_jsonb('in_work'::text),
            'Статус: «Новая заявка» → «В работе»: заявка «Заключение ДП» ID ' || v_num || ' взята в работу', v_role, v_name);
  END IF;

  -- Исполнители заявки сменились: юрист договора — первый действующий юрист ОСП из них, пока юрист договора пуст или он из
  -- прежних исполнителей и снят с заявки. Поставленного в реестре вручную (не из исполнителей заявки) не трогаем.
  IF NEW.assignee_ids IS DISTINCT FROM OLD.assignee_ids
     AND (k.responsible_user_id IS NULL
          OR (k.responsible_user_id = ANY (coalesce(OLD.assignee_ids, '{}'::uuid[]))
              AND NOT k.responsible_user_id = ANY (coalesce(NEW.assignee_ids, '{}'::uuid[])))) THEN
    v_lawyer := public.osp_first_lawyer(NEW.assignee_ids);
    IF v_lawyer IS DISTINCT FROM k.responsible_user_id THEN
      UPDATE public.contracts SET responsible_user_id = v_lawyer WHERE id = k.id;
      INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_role, changed_by_name)
      VALUES (k.id, 'field_updated', 'responsible_user_id',
              to_jsonb(public.osp_user_display_name(k.responsible_user_id)), to_jsonb(public.osp_user_display_name(v_lawyer)),
              'Ответственный юрист: ' || coalesce(public.osp_user_display_name(k.responsible_user_id), '—') || ' → '
                || coalesce(public.osp_user_display_name(v_lawyer), '—') || ' (исполнители заявки «Заключение ДП» ID ' || v_num || ')',
              v_role, v_name);
    END IF;
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS doc_check_dp_conclusion_contract ON public.doc_check_requests;
CREATE TRIGGER doc_check_dp_conclusion_contract
  AFTER INSERT OR UPDATE OF status, doc_type, deleted_at, assignee_ids ON public.doc_check_requests
  FOR EACH ROW WHEN (NEW.doc_type = 'dp_conclusion')
  EXECUTE FUNCTION public.doc_check_dp_conclusion_contract();

-- ── 5. Заявки, которые уже на доске ───────────────────────────────────────────────────────────────────
-- Любая колонка, не удалённые, без договора. Похожий договор, внесённый вручную (тот же объект и контрагент, если он в заявке,
-- не раньше дня подачи; договоры из других заявок — не в счёт), — пропуск, как в 20270225. Повтор второго договора не создаёт.
DO $$
DECLARE
  q record;
  v_made integer := 0;
  v_skipped integer := 0;
BEGIN
  FOR q IN
    SELECT r.id, r.object_id, r.counterparty_id, r.created_at, to_jsonb(r) ->> 'request_number' AS num
    FROM public.doc_check_requests r
    WHERE r.doc_type = 'dp_conclusion' AND r.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.contracts c WHERE c.doc_check_request_id = r.id)
    ORDER BY r.created_at, r.id
  LOOP
    IF q.object_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE c.record_type = 'dp' AND c.deleted_at IS NULL AND c.object_id = q.object_id
        AND c.created_at >= date_trunc('day', q.created_at) AND c.doc_check_request_id IS NULL
        AND (q.counterparty_id IS NULL OR c.counterparty_id = q.counterparty_id
             OR EXISTS (SELECT 1 FROM public.contract_counterparties cc
                        WHERE cc.contract_id = c.id AND cc.counterparty_id = q.counterparty_id))) THEN
      v_skipped := v_skipped + 1;
    ELSIF public.dp_conclusion_contract_create(q.id, 'при выкладке: заявка «Заключение ДП» ID ' || coalesce(q.num, '—')
                                               || ' уже была на доске') IS NOT NULL THEN
      v_made := v_made + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'Заявки «Заключение ДП» на доске: договоров создано %, пропущено (похожий договор уже есть) %', v_made, v_skipped;
END
$$;

-- ── Права ─────────────────────────────────────────────────────────────────────────────────────────────
-- Служебные — страница их не вызывает; list_osp_lawyers — вошедшему (показ и выбор юриста).
REVOKE ALL ON FUNCTION public.list_osp_lawyers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_osp_lawyers() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.osp_is_active_lawyer(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.osp_first_lawyer(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.osp_user_display_name(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.contracts_lawyer_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dp_conclusion_contract_create(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.doc_check_dp_conclusion_contract() FROM PUBLIC, anon, authenticated;

-- PostgREST перечитывает схему (новая колонка contracts.responsible_user_id).
NOTIFY pgrst, 'reload schema';

COMMIT;
