-- АВАРИЙНЫЙ ОТКАТ 20270228_doc_check_registry_docs: «Проверки ДП/ДС» снова не попадают в «Реестр по договорам»; триггер доски —
-- как в 20270226 (только «Заключение ДП», без защиты сохранения заявки от отказов реестра).
-- Документы, созданные из заявок, ОСТАЮТСЯ в реестре (связь contracts.doc_check_request_id тоже — окно заявки по-прежнему ведёт в
-- реестр); пометка «Вероятно, ошибочное создание» в примечании заявки остаётся; записи «Истории» — тоже. Откатывать вместе со
-- страницей не обязательно: окно заявки и реестр работают и после отката. Одной транзакцией, повтор безопасен. Подходит обеим
-- базам (Supabase и Яндекса).
BEGIN;
SET LOCAL lock_timeout = '10s';

-- Как в 20270226_registry_osp_lawyers.sql.
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

DROP FUNCTION IF EXISTS public.doc_check_registry_doc_create(uuid, text);
DROP FUNCTION IF EXISTS public.doc_check_registry_note(uuid, text, jsonb, text);
DROP FUNCTION IF EXISTS public.doc_check_type_title(text);
DROP FUNCTION IF EXISTS public.doc_check_number_contains(text, text);
DROP FUNCTION IF EXISTS public.doc_check_number_key(text);
DROP FUNCTION IF EXISTS public.doc_check_number_spaced(text);
DROP FUNCTION IF EXISTS public.doc_check_number_clean(text);

COMMIT;
