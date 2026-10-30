-- Откат правки migration/data/20261030_ds_760_amount.sql (сумма ДС 760).
--
-- Возвращает ДС 760 прежнюю сумму по журналу «История» (contract_audit_log, запись правки — new_value.fix =
-- '20261030_ds_760_amount'): через «на доработку» и обратно в прежний статус, как на сайте. Откатывает, только
-- если с правки сумму и статус никто не менял и к ДС не прикрепили ДС — иначе ошибка и ничего не меняется.
-- В «История» — строка об откате.
--
-- По умолчанию — ПРОБНЫЙ прогон (ROLLBACK); откатить — с -v apply=1. В выводе только ID и числа.
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X [-v apply=1] -f migration/data/20261030_ds_760_amount_rollback.sql )
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
  c_fix constant text := '20261030_ds_760_amount';
  c_who constant text := 'Исправление данных 30.10.2026 (скрипт, откат)';
  r record; v_at timestamptz; n int; v_cur jsonb;
BEGIN
  -- Последнее применение правки.
  SELECT max(changed_at) INTO v_at FROM public.contract_audit_log WHERE new_value ->> 'fix' = c_fix;
  IF v_at IS NULL THEN RAISE EXCEPTION 'Правка не применялась — откатывать нечего'; END IF;
  IF EXISTS (SELECT 1 FROM public.contract_audit_log WHERE new_value ->> 'fix_rollback' = c_fix AND changed_at > v_at) THEN
    RAISE EXCEPTION 'Правка уже откачена';
  END IF;
  SELECT count(*) INTO n FROM public.contract_audit_log WHERE new_value ->> 'fix' = c_fix AND changed_at = v_at;
  IF n <> 1 THEN RAISE EXCEPTION 'В журнале % записей правки (ждали 1) — разбирать вручную', n; END IF;

  SELECT l.contract_id, l.event_type, l.old_value, l.new_value, c.display_id INTO r
    FROM public.contract_audit_log l JOIN public.contracts c ON c.id = l.contract_id
   WHERE l.new_value ->> 'fix' = c_fix AND l.changed_at = v_at;

  -- Проверка: с правки ничего не меняли.
  SELECT to_jsonb(c) INTO v_cur FROM public.contracts c WHERE c.id = r.contract_id;
  IF r.event_type <> 'field_updated' OR r.display_id <> 760 THEN
    RAISE EXCEPTION 'В журнале правки не сумма ДС 760 — разбирать вручную';
  END IF;
  IF (v_cur ->> 'contract_amount')::numeric IS DISTINCT FROM (r.new_value ->> 'contract_amount')::numeric
     OR v_cur ->> 'status' IS DISTINCT FROM r.new_value ->> 'status' OR v_cur ->> 'deleted_at' IS NOT NULL THEN
    RAISE EXCEPTION 'ID %: сумму или статус уже меняли после правки — откатывать вручную', r.display_id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.contracts k WHERE k.parent_contract_id = r.contract_id AND k.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'ID %: к ДС уже прикрепили ДС — откатывать вручную', r.display_id;
  END IF;

  -- Откат.
  UPDATE public.contracts SET status = 'in_work' WHERE id = r.contract_id AND status = 'completed';
  UPDATE public.contracts SET contract_amount = (r.old_value ->> 'contract_amount')::numeric WHERE id = r.contract_id;
  UPDATE public.contracts SET status = r.old_value ->> 'status' WHERE id = r.contract_id;
  INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
  VALUES (r.contract_id, 'field_updated', 'contract_amount', r.new_value - 'fix',
          (r.old_value - 'updated_at') || jsonb_build_object('fix_rollback', c_fix),
          'Откат исправления 30.10: сумма ДС возвращена прежняя.', c_who);
  RAISE NOTICE 'откат: ID % — сумма %', r.display_id, r.old_value ->> 'contract_amount';

  -- Проверка «после».
  SELECT to_jsonb(c) INTO v_cur FROM public.contracts c WHERE c.id = r.contract_id;
  IF (v_cur ->> 'contract_amount')::numeric IS DISTINCT FROM (r.old_value ->> 'contract_amount')::numeric
     OR v_cur ->> 'status' IS DISTINCT FROM r.old_value ->> 'status' THEN
    RAISE EXCEPTION 'FAIL ID %: сумма или статус не вернулись', r.display_id;
  END IF;
  RAISE NOTICE 'OK: откат сошёлся';
END $$;

\if :apply
COMMIT;
\echo 'Откачено.'
\else
ROLLBACK;
\echo 'Пробный прогон отката: изменения откачены. Откатить — с -v apply=1.'
\endif
