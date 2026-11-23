-- АВАРИЙНЫЙ ОТКАТ 20270226_registry_osp_lawyers: договор из «Заключения ДП» снова создаётся только при входе заявки в «В работе»
-- (функции и триггер 20270225 возвращаются дословно), юрист договора — снова запись «Сотрудников» (responsible_contact_id: миграция её
-- не меняла, прежние юристы, в том числе снятые, вернутся в реестр), проверки «только действующий юрист ОСП» нет.
-- Теряется: юрист договора, назначенный после миграции (колонка responsible_user_id удаляется) — перед откатом снимите список:
--   select c.display_id, coalesce(ur.full_name, ur.email) from public.contracts c join public.user_roles ur on ur.user_id = c.responsible_user_id;
-- Договоры, созданные из заявок, ОСТАЮТСЯ в реестре; перенесённые в «Удалённые» удалением заявки — остаются там (вернуть — «Восстановить»).
-- Откатывать вместе со страницей (реестр без колонки показывает прежнего юриста) и шлюзом (allow.json и db-sections.json:
-- list_osp_lawyers, responsible_user_id в колонках «Отчётов»). Одной транзакцией, повтор безопасен. Подходит обеим
-- базам (Supabase и Яндекса).
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS contracts_lawyer_guard ON public.contracts;
DROP FUNCTION IF EXISTS public.contracts_lawyer_guard();

-- Как в 20270225_dp_conclusion_registry_contract.sql.
-- ── 2. Договор из заявки ──────────────────────────────────────────────────────────────────────────────
-- Договор подряда «В работе»: объект, контрагент, тендер — из заявки; номер не присваивается (юрист подставляет его в форме
-- договора — кнопка «Подставить» — или вводит свой); «Принят в работу» — сегодня по Москве; в примечании — ID заявки и её
-- примечание. Файлы остаются в заявке. В «Истории» договора — «Создание», в истории заявки — «Договор в реестре». Заявки не того
-- типа, удалённые, в «Новых» или уже с договором — ничего. → id созданного договора или NULL.
CREATE OR REPLACE FUNCTION public.dp_conclusion_contract_create(p_request uuid, p_reason text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  r public.doc_check_requests%ROWTYPE;
  v_number text;
  v_tender uuid;
  v_id uuid;
  v_display bigint;
  v_name text;
  v_role text;
BEGIN
  SELECT * INTO r FROM public.doc_check_requests WHERE id = p_request;
  IF NOT FOUND OR r.doc_type IS DISTINCT FROM 'dp_conclusion' OR r.deleted_at IS NOT NULL OR r.status = 'new' THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.contracts c WHERE c.doc_check_request_id = r.id) THEN RETURN NULL; END IF;

  v_number := coalesce(to_jsonb(r) ->> 'request_number', '—');
  -- Тендер заявки (20270221) — если колонка есть.
  v_tender := (to_jsonb(r) ->> 'tender_id')::uuid;

  INSERT INTO public.contracts (record_type, status, object_id, counterparty_id, tender_id, accepted_date, notes, doc_check_request_id)
  VALUES ('dp', 'in_work', r.object_id, r.counterparty_id, v_tender, (now() AT TIME ZONE 'Europe/Moscow')::date,
          concat_ws(E'\n', 'Из заявки «Заключение ДП» ID ' || v_number, nullif(btrim(r.notes), '')), r.id)
  ON CONFLICT (doc_check_request_id) WHERE doc_check_request_id IS NOT NULL DO NOTHING
  RETURNING id, display_id INTO v_id, v_display;
  IF v_id IS NULL THEN RETURN NULL; END IF;

  IF r.counterparty_id IS NOT NULL THEN
    INSERT INTO public.contract_counterparties (contract_id, counterparty_id, sort_order)
    VALUES (v_id, r.counterparty_id, 0)
    ON CONFLICT (contract_id, counterparty_id) DO NOTHING;
  END IF;

  -- Кто перевёл заявку (у выкладки — никто).
  SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), '')), ur.role INTO v_name, v_role
  FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;

  INSERT INTO public.contract_audit_log (contract_id, event_type, new_value, description, changed_by_role, changed_by_name)
  VALUES (v_id, 'created', jsonb_build_object('doc_check_request_id', r.id, 'request_number', v_number),
          'Создан договор (без номера) ' || p_reason, v_role, v_name);

  INSERT INTO public.doc_check_request_audit_log
    (request_id, event_type, field_name, new_value, description, changed_at, changed_by_role, changed_by_name)
  VALUES (r.id, 'contract_created', NULL, jsonb_build_object('contract_id', v_id, 'display_id', v_display),
          'Договор создан в «Реестре по договорам»: ID ' || v_display, now(), v_role, coalesce(v_name, 'Автоматически'));
  RETURN v_id;
END
$$;

-- Заявка «Заключение ДП» стала «В работе» (или ушла из «Новых» сразу дальше, или создана не в «Новых») — договор. Переходы между
-- следующими колонками, правка полей без смены статуса и возврат в «Новые» договор не трогают; удаление заявки — тоже.
CREATE OR REPLACE FUNCTION public.doc_check_dp_conclusion_contract() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.doc_type IS NOT DISTINCT FROM OLD.doc_type
     AND (OLD.deleted_at IS NULL) = (NEW.deleted_at IS NULL) THEN
    RETURN NULL;
  END IF;
  IF NEW.status = 'in_progress' OR TG_OP = 'INSERT' OR OLD.status = 'new' THEN
    PERFORM public.dp_conclusion_contract_create(NEW.id, 'автоматически: заявка «Заключение ДП» ID '
      || coalesce(to_jsonb(NEW) ->> 'request_number', '—') || ' взята в работу');
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS doc_check_dp_conclusion_contract ON public.doc_check_requests;
CREATE TRIGGER doc_check_dp_conclusion_contract
  AFTER INSERT OR UPDATE OF status, doc_type, deleted_at ON public.doc_check_requests
  FOR EACH ROW WHEN (NEW.doc_type = 'dp_conclusion' AND NEW.deleted_at IS NULL AND NEW.status <> 'new')
  EXECUTE FUNCTION public.doc_check_dp_conclusion_contract();

DROP FUNCTION IF EXISTS public.osp_first_lawyer(uuid[]);
DROP FUNCTION IF EXISTS public.osp_is_active_lawyer(uuid);
DROP FUNCTION IF EXISTS public.osp_user_display_name(uuid);
DROP FUNCTION IF EXISTS public.list_osp_lawyers();
DROP INDEX IF EXISTS public.contracts_responsible_user_idx;
ALTER TABLE public.contracts DROP COLUMN IF EXISTS responsible_user_id;

COMMIT;
