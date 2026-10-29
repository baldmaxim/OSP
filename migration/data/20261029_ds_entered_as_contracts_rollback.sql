-- Откат правки migration/data/20261029_ds_entered_as_contracts.sql (ДС, заведённые в «Договорах и ДС» договорами).
--
-- Восстанавливает по журналу «История» (contract_audit_log, записи правки — new_value.fix =
-- '20261029_ds_entered_as_contracts'): семь записей снова «Договор» с прежними номером и условиями, дубли
-- ID 821 и 833 возвращаются из «Удаленных». Откатывает, только если с правки эти поля никто не менял и к
-- исправленным ДС не прикрепили новых ДС — иначе ошибка и ничего не меняется (разбирать вручную).
-- Тип меняется при выключенном на время транзакции триггере иерархии, затем записи проходят через него повторно.
-- В «История» каждой записи — строка об откате.
--
-- По умолчанию — ПРОБНЫЙ прогон (ROLLBACK); откатить — с -v apply=1. В выводе только ID и числа.
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X [-v apply=1] -f migration/data/20261029_ds_entered_as_contracts_rollback.sql )
\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_catalog.set_config('application_name', 'osp:internal', true) \gset ignored_

DO $$
DECLARE
  c_fix constant text := '20261029_ds_entered_as_contracts';
  c_who constant text := 'Исправление данных 29.10.2026 (скрипт)';
  r record;
  v_ids uuid[]; v_fixed uuid[]; v_dups uuid[];
  v_cur jsonb; n int; v_at timestamptz;
BEGIN
  -- Последнее применение правки (записи журнала одной транзакции — одно время).
  SELECT max(changed_at) INTO v_at FROM public.contract_audit_log WHERE new_value ->> 'fix' = c_fix;
  IF v_at IS NULL THEN RAISE EXCEPTION 'Правка не применялась — откатывать нечего'; END IF;
  IF EXISTS (SELECT 1 FROM public.contract_audit_log WHERE new_value ->> 'fix_rollback' = c_fix AND changed_at > v_at) THEN
    RAISE EXCEPTION 'Правка уже откачена';
  END IF;
  SELECT array_agg(contract_id ORDER BY contract_id) INTO v_ids FROM public.contract_audit_log
   WHERE new_value ->> 'fix' = c_fix AND changed_at = v_at;
  IF cardinality(v_ids) IS DISTINCT FROM 9 THEN
    RAISE EXCEPTION 'Записей правки в журнале % (ждали 9) — правка не применялась?', coalesce(cardinality(v_ids), 0);
  END IF;
  PERFORM 1 FROM public.contracts WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE;
  SELECT array_agg(contract_id) FILTER (WHERE field_name = 'record_type'),
         array_agg(contract_id) FILTER (WHERE event_type = 'soft_deleted')
    INTO v_fixed, v_dups
    FROM public.contract_audit_log WHERE new_value ->> 'fix' = c_fix AND changed_at = v_at;
  IF cardinality(v_fixed) <> 7 OR cardinality(v_dups) <> 2 THEN
    RAISE EXCEPTION 'В журнале правки записей % и дублей % (ждали 7 и 2)', cardinality(v_fixed), cardinality(v_dups);
  END IF;

  -- ── До отката: всё так, как оставила правка ─────────────────────────────────────────────────────────────────
  FOR r IN SELECT l.contract_id, l.new_value - 'fix' AS after, c.display_id, to_jsonb(c) AS cur
             FROM public.contract_audit_log l JOIN public.contracts c ON c.id = l.contract_id
            WHERE l.new_value ->> 'fix' = c_fix AND l.changed_at = v_at ORDER BY c.display_id LOOP
    SELECT jsonb_object_agg(k, v) INTO v_cur FROM jsonb_each(r.cur) e(k, v) WHERE r.after ? k;
    IF v_cur IS DISTINCT FROM r.after THEN
      RAISE EXCEPTION 'ID %: с правки запись изменили — откат вручную', r.display_id;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.contracts k
              WHERE k.parent_contract_id = ANY (v_fixed) AND k.deleted_at IS NULL AND NOT (k.id = ANY (v_fixed))) THEN
    RAISE EXCEPTION 'К исправленным ДС прикрепили новые ДС — откат вручную';
  END IF;
  RAISE NOTICE 'до:    записей % и дублей % — как после правки', cardinality(v_fixed), cardinality(v_dups);

  -- ── Откат ──────────────────────────────────────────────────────────────────────────────────────────────────
  EXECUTE 'ALTER TABLE public.contracts DISABLE TRIGGER trg_contracts_hierarchy_guard';
  FOR r IN SELECT l.contract_id, l.old_value FROM public.contract_audit_log l
            WHERE l.new_value ->> 'fix' = c_fix AND l.changed_at = v_at AND l.field_name = 'record_type' LOOP
    UPDATE public.contracts c SET
      record_type = x.record_type, parent_contract_id = x.parent_contract_id, root_contract_id = x.root_contract_id,
      contract_number = x.contract_number, changed_fields = x.changed_fields,
      contract_date = x.contract_date, signed_date = x.signed_date, document_link = x.document_link,
      contract_amount = x.contract_amount, gp_amount = x.gp_amount, currency = x.currency, vat_rate = x.vat_rate,
      amount_includes_vat = x.amount_includes_vat, bsm = x.bsm, work_name = x.work_name,
      work_start_date = x.work_start_date, work_end_date = x.work_end_date,
      warranty_retention_percent = x.warranty_retention_percent, warranty_retention_period = x.warranty_retention_period,
      warranty_period = x.warranty_period, gen_director_name = x.gen_director_name, phone = x.phone, email = x.email,
      comments = x.comments
    FROM public.contracts cur, jsonb_populate_record(NULL::public.contracts, to_jsonb(cur) || r.old_value) AS x
    WHERE cur.id = r.contract_id AND c.id = r.contract_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'Откат записи: строк % (ждали 1)', n; END IF;
  END LOOP;
  EXECUTE 'ALTER TABLE public.contracts ENABLE TRIGGER trg_contracts_hierarchy_guard';

  -- Дубли — из «Удаленных» (триггеры включены и проверяют это сами), затем проверка восстановленных триггером.
  UPDATE public.contracts SET deleted_at = NULL WHERE id = ANY (v_dups) AND deleted_at IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 2 THEN RAISE EXCEPTION 'Из «Удаленных» возвращено % (ждали 2)', n; END IF;
  UPDATE public.contracts SET parent_contract_id = parent_contract_id WHERE id = ANY (v_fixed);

  INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
  SELECT l.contract_id,
         CASE WHEN l.event_type = 'soft_deleted' THEN 'restored' ELSE 'field_updated' END,
         l.field_name, l.new_value - 'fix', l.old_value || jsonb_build_object('fix_rollback', c_fix),
         CASE WHEN l.event_type = 'soft_deleted'
              THEN 'Откат исправления 29.10.2026: дубль возвращён из «Удалённых».'
              ELSE 'Откат исправления 29.10.2026: снова «Договор» с прежними номером и условиями.' END,
         c_who
    FROM public.contract_audit_log l WHERE l.new_value ->> 'fix' = c_fix AND l.changed_at = v_at;

  -- ── После отката: всё как до правки ────────────────────────────────────────────────────────────────────────
  FOR r IN SELECT l.contract_id, l.old_value, c.display_id, to_jsonb(c) AS cur
             FROM public.contract_audit_log l JOIN public.contracts c ON c.id = l.contract_id
            WHERE l.new_value ->> 'fix' = c_fix AND l.changed_at = v_at ORDER BY c.display_id LOOP
    SELECT jsonb_object_agg(k, v) INTO v_cur FROM jsonb_each(r.cur) e(k, v) WHERE r.old_value ? k;
    IF v_cur IS DISTINCT FROM r.old_value THEN
      RAISE EXCEPTION 'FAIL ID %: после отката не то, что было до правки', r.display_id;
    END IF;
  END LOOP;
  IF (SELECT tgenabled FROM pg_catalog.pg_trigger
       WHERE tgrelid = 'public.contracts'::regclass AND tgname = 'trg_contracts_hierarchy_guard') <> 'O' THEN
    RAISE EXCEPTION 'FAIL: триггер иерархии не включён';
  END IF;
  RAISE NOTICE 'OK: записи и дубли — как до правки';
END $$;

\if :apply
COMMIT;
\echo 'Откат применён.'
\else
ROLLBACK;
\echo 'Пробный прогон: изменения откачены. Откатить — с -v apply=1.'
\endif
