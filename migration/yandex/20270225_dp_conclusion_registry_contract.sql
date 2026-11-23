-- «Заключение ДП» → «Реестр по договорам» и большое окно исполнителю. Решение пользователя 23.11.2026: «заявка на заключение ДП со
-- статусом в работе как и в /doc-check-requests также автоматически создавалась в /contracts/registry, и большое уведомление
-- (похожее как мы уже создавали на весь экран) появлялось у ответственного при его назначении». Уточнено им же: ответственный —
-- исполнитель заявки на доске (юрист ОСП), окно — только у «Заключения ДП», заявкам, которые уже «В работе», — договор, «если их
-- ещё нет». Тело (от «DO $$» до «── Права») — то же, что supabase/migrations/20270225_dp_conclusion_registry_contract.sql.
--
--  • 1. contracts.doc_check_request_id — из какой заявки создан договор; уникальна: одна заявка — один договор.
--  • 2. Заявка «Заключение ДП» входит в «В работе» (или сразу из «Новых» дальше, или создана не в «Новых») — триггер создаёт
--    договор подряда «В работе»: объект, контрагент, тендер — из заявки, номер не присваивается (юрист подставляет его кнопкой
--    «Подставить» в форме договора), «Принят в работу» — сегодня, в примечании — ID заявки и её примечание. «Создание» — в
--    «Истории» договора, «Договор в реестре» — в истории заявки. Возврат карточки в «Новые», переходы дальше, удаление заявки
--    договор не трогают; повторный вход в «В работе» второго договора не создаёт. Права на договоры не меняются: создаёт база
--    (служебная функция), перевести карточку может только тот, кто и так правит доску.
--  • 3. Большое окно исполнителю: doc_check_assign_alerts — уведомление, когда человека добавили в исполнители «Заключения ДП»
--    (сам себя — нет; сняли до прочтения — уведомление убирается). Читает и гасит своё только функциями
--    doc_check_assign_my_alerts / doc_check_assign_alerts_ack; таблица для вошедших закрыта.
--  • 4. Заявки, уже стоящие «В работе», — договор, если похожего ещё нет (тот же объект и контрагент, внесён не раньше дня
--    подачи заявки); сколько создано и пропущено — в NOTICE и в проверке.
-- Нужны 20270123 (ID заявки) и 20270216 (история заявки от базы); тип «Заключение ДП» (20270219) триггеры только ждут.
-- Повтор безопасен. Проверка — 20270225_dp_conclusion_registry_contract.check.sql, для прода —
-- migration/backup/checks/20270225.sql; откат — migration/rollback/20270225_dp_conclusion_registry_contract_rollback.sql.
-- В нерабочее время: ALTER TABLE ненадолго блокирует договоры и заявки доски.
DO $$
BEGIN
  IF to_regprocedure('public.doc_check_history_write(uuid, text, text, jsonb, jsonb, text)') IS NULL THEN
    RAISE EXCEPTION 'Нет истории заявок от базы: сначала 20270216_doc_check_chat_history';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'doc_check_requests'
                 AND column_name = 'request_number') THEN
    RAISE EXCEPTION 'Нет постоянного ID заявок доски: сначала 20270123_doc_check_request_number';
  END IF;
END
$$;

-- ── 1. Договор помнит, из какой заявки он создан ──────────────────────────────────────────────────────
-- Одна заявка — не больше одного договора: карточку двигают туда-обратно, а договор создаётся один раз. Заявку удалили
-- безвозвратно (служебная операция) — ссылка пустеет, договор остаётся.
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS doc_check_request_id uuid;
ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_doc_check_request_id_fkey;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_doc_check_request_id_fkey
  FOREIGN KEY (doc_check_request_id) REFERENCES public.doc_check_requests(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contracts_doc_check_request_uniq ON public.contracts (doc_check_request_id)
  WHERE doc_check_request_id IS NOT NULL;
COMMENT ON COLUMN public.contracts.doc_check_request_id IS
  'Заявка «Заключение ДП» доски ДП/ДС, из которой договор создан автоматически (с 20270225); NULL — внесён в реестр иначе';

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

-- ── 3. Большое окно исполнителю «Заключения ДП» ───────────────────────────────────────────────────────
-- Уведомление заводит база, когда человека добавили в исполнители (сам себя — нет); сняли до того, как он закрыл окно, — окна
-- нет. Назначили снова после прочтения — окно снова. Окно читает и гасит только своё — функциями.
CREATE TABLE IF NOT EXISTS public.doc_check_assign_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.doc_check_requests(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  assigned_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT doc_check_assign_alerts_unique UNIQUE (request_id, user_id)
);
CREATE INDEX IF NOT EXISTS doc_check_assign_alerts_unread_idx ON public.doc_check_assign_alerts (user_id, created_at) WHERE read_at IS NULL;
COMMENT ON TABLE public.doc_check_assign_alerts IS
  'Уведомление исполнителю о назначении на заявку «Заключение ДП» (большое окно): заводит триггер, read_at ставит doc_check_assign_alerts_ack';

CREATE OR REPLACE FUNCTION public.doc_check_assign_alert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_old uuid[] := CASE WHEN TG_OP = 'UPDATE' THEN coalesce(OLD.assignee_ids, '{}'::uuid[]) ELSE '{}'::uuid[] END;
  v_new uuid[] := coalesce(NEW.assignee_ids, '{}'::uuid[]);
  v_name text;
BEGIN
  IF NEW.doc_type = 'dp_conclusion' AND NEW.deleted_at IS NULL THEN
    SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), '')) INTO v_name
    FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;
    INSERT INTO public.doc_check_assign_alerts (request_id, user_id, assigned_by_name)
    SELECT DISTINCT NEW.id, u, v_name FROM unnest(v_new) u
    WHERE u IS NOT NULL AND NOT (u = ANY (v_old)) AND u IS DISTINCT FROM auth.uid()
    ON CONFLICT (request_id, user_id) DO UPDATE
      SET created_at = now(), read_at = NULL, assigned_by_name = EXCLUDED.assigned_by_name;
  END IF;
  DELETE FROM public.doc_check_assign_alerts a
  WHERE a.request_id = NEW.id AND a.read_at IS NULL AND NOT (a.user_id = ANY (v_new));
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS doc_check_assign_alert ON public.doc_check_requests;
CREATE TRIGGER doc_check_assign_alert
  AFTER INSERT OR UPDATE OF assignee_ids ON public.doc_check_requests
  FOR EACH ROW EXECUTE FUNCTION public.doc_check_assign_alert();

-- Непрочитанные уведомления вошедшего — только пока он исполнитель и заявка не удалена; со сведениями заявки и договором реестра.
CREATE OR REPLACE FUNCTION public.doc_check_assign_my_alerts()
  RETURNS TABLE (request_id uuid, request_number integer, status text, object_name text, counterparty_name text, notes text,
                 created_by_name text, assigned_by_name text, contract_id uuid, contract_display_id bigint, alerted_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT r.id, r.request_number, r.status, o.name::text, cp.name::text, r.notes, r.created_by_name, a.assigned_by_name,
         c.id, c.display_id, a.created_at
  FROM public.doc_check_assign_alerts a
  JOIN public.doc_check_requests r ON r.id = a.request_id AND r.deleted_at IS NULL AND a.user_id = ANY (r.assignee_ids)
  LEFT JOIN public.objects o ON o.id = r.object_id
  LEFT JOIN public.counterparties cp ON cp.id = r.counterparty_id
  LEFT JOIN public.contracts c ON c.doc_check_request_id = r.id AND c.deleted_at IS NULL
  WHERE a.user_id = auth.uid() AND a.read_at IS NULL AND public.osp_is_employee()
  ORDER BY a.created_at, a.id
  LIMIT 200
$$;

-- Человек закрыл окно: только свои уведомления. → сколько погашено.
CREATE OR REPLACE FUNCTION public.doc_check_assign_alerts_ack(p_requests uuid[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Нужен вход' USING ERRCODE = '42501';
  END IF;
  UPDATE public.doc_check_assign_alerts SET read_at = now()
  WHERE user_id = auth.uid() AND read_at IS NULL AND request_id = ANY (p_requests);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- ── 4. Заявки, которые уже «В работе» ─────────────────────────────────────────────────────────────────
-- Договор — только если его ещё нет: не создаётся, когда в реестре уже есть живой договор подряда того же объекта (и того же
-- контрагента, если он в заявке указан), внесённый не раньше дня подачи заявки, — его, вероятно, внесли вручную. Такие заявки
-- договора не получают и при следующем переходе по колонкам (договор создаётся только при входе в «В работе»). Заявки в
-- следующих колонках не трогаются. Повтор не создаёт второго договора.
DO $$
DECLARE
  q record;
  v_made integer := 0;
  v_skipped integer := 0;
BEGIN
  FOR q IN
    SELECT r.id, r.object_id, r.counterparty_id, r.created_at, to_jsonb(r) ->> 'request_number' AS num
    FROM public.doc_check_requests r
    WHERE r.doc_type = 'dp_conclusion' AND r.deleted_at IS NULL AND r.status = 'in_progress'
      AND NOT EXISTS (SELECT 1 FROM public.contracts c WHERE c.doc_check_request_id = r.id)
    ORDER BY r.created_at, r.id
  LOOP
    IF q.object_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE c.record_type = 'dp' AND c.deleted_at IS NULL AND c.object_id = q.object_id
        AND c.created_at >= date_trunc('day', q.created_at)
        AND (q.counterparty_id IS NULL OR c.counterparty_id = q.counterparty_id
             OR EXISTS (SELECT 1 FROM public.contract_counterparties cc
                        WHERE cc.contract_id = c.id AND cc.counterparty_id = q.counterparty_id))) THEN
      v_skipped := v_skipped + 1;
    ELSIF public.dp_conclusion_contract_create(q.id, 'при выкладке: заявка «Заключение ДП» ID ' || coalesce(q.num, '—')
                                               || ' уже была в работе') IS NOT NULL THEN
      v_made := v_made + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'Заявки «Заключение ДП» в работе: договоров создано %, пропущено (похожий договор уже есть) %', v_made, v_skipped;
END
$$;

-- ── Права ─────────────────────────────────────────────────────────────────────────────────────────────
-- Уведомления — только функциями: правил для вошедших нет.
ALTER TABLE public.doc_check_assign_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doc_check_assign_alerts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osp_internal ON public.doc_check_assign_alerts;
CREATE POLICY osp_internal ON public.doc_check_assign_alerts FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
REVOKE ALL ON FUNCTION public.dp_conclusion_contract_create(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.doc_check_dp_conclusion_contract() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.doc_check_assign_alert() FROM PUBLIC;

-- osp:allow rpc doc_check_assign_my_alerts authenticated
-- osp:allow rpc doc_check_assign_alerts_ack authenticated
-- osp:allow table doc_check_assign_alerts none
