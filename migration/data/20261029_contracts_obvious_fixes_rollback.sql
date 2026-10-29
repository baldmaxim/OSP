-- Откат правки migration/data/20261029_contracts_obvious_fixes.sql (ДС 760 и дубли 333, 358).
--
-- Восстанавливает по журналу «История» (contract_audit_log, записи правки — new_value.fix =
-- '20261029_contracts_obvious_fixes'): у ДС 760 — прежняя сумма (через «на доработку» и обратно в «Завершено»,
-- как на сайте), ID 333 и 358 возвращаются из «Удаленных». Откатывает, только если с правки эти поля никто не
-- менял (сумма ДС 760 та же, дубли всё ещё в «Удаленных» с тем же временем) — иначе ошибка и ничего не меняется.
-- В «История» каждой записи — строка об откате.
--
-- По умолчанию — ПРОБНЫЙ прогон (ROLLBACK); откатить — с -v apply=1. В выводе только ID и числа.
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X [-v apply=1] -f migration/data/20261029_contracts_obvious_fixes_rollback.sql )
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
  c_fix constant text := '20261029_contracts_obvious_fixes';
  c_who constant text := 'Исправление данных 29.10.2026 (скрипт, откат)';
  r record; v_at timestamptz; n int; v_cur jsonb;
BEGIN
  -- Последнее применение правки (записи журнала одной транзакции — одно время).
  SELECT max(changed_at) INTO v_at FROM public.contract_audit_log WHERE new_value ->> 'fix' = c_fix;
  IF v_at IS NULL THEN RAISE EXCEPTION 'Правка не применялась — откатывать нечего'; END IF;
  IF EXISTS (SELECT 1 FROM public.contract_audit_log WHERE new_value ->> 'fix_rollback' = c_fix AND changed_at > v_at) THEN
    RAISE EXCEPTION 'Правка уже откачена';
  END IF;
  SELECT count(*) INTO n FROM public.contract_audit_log WHERE new_value ->> 'fix' = c_fix AND changed_at = v_at;
  IF n <> 3 THEN RAISE EXCEPTION 'В журнале % записей правки (ждали 3) — разбирать вручную', n; END IF;

  -- Проверка: с правки ничего не меняли.
  FOR r IN SELECT l.contract_id, l.event_type, l.old_value, l.new_value, c.display_id
             FROM public.contract_audit_log l JOIN public.contracts c ON c.id = l.contract_id
            WHERE l.new_value ->> 'fix' = c_fix AND l.changed_at = v_at LOOP
    SELECT to_jsonb(c) INTO v_cur FROM public.contracts c WHERE c.id = r.contract_id;
    IF r.event_type = 'field_updated' THEN
      IF (v_cur ->> 'contract_amount')::numeric IS DISTINCT FROM (r.new_value ->> 'contract_amount')::numeric
         OR v_cur ->> 'status' IS DISTINCT FROM r.new_value ->> 'status' OR v_cur ->> 'deleted_at' IS NOT NULL THEN
        RAISE EXCEPTION 'ID %: сумму или статус уже меняли после правки — откатывать вручную', r.display_id;
      END IF;
      IF EXISTS (SELECT 1 FROM public.contracts k WHERE k.parent_contract_id = r.contract_id AND k.deleted_at IS NULL) THEN
        RAISE EXCEPTION 'ID %: к ДС уже прикрепили ДС — откатывать вручную', r.display_id;
      END IF;
    ELSIF r.event_type = 'soft_deleted' THEN
      IF v_cur ->> 'deleted_at' IS NULL
         OR (v_cur ->> 'deleted_at')::timestamptz IS DISTINCT FROM (r.new_value ->> 'deleted_at')::timestamptz THEN
        RAISE EXCEPTION 'ID %: уже не в «Удаленных» или удалён позже заново — откатывать вручную', r.display_id;
      END IF;
    END IF;
  END LOOP;

  -- Откат.
  FOR r IN SELECT l.contract_id, l.event_type, l.old_value, l.new_value, c.display_id
             FROM public.contract_audit_log l JOIN public.contracts c ON c.id = l.contract_id
            WHERE l.new_value ->> 'fix' = c_fix AND l.changed_at = v_at ORDER BY c.display_id LOOP
    IF r.event_type = 'field_updated' THEN
      UPDATE public.contracts SET status = 'in_work' WHERE id = r.contract_id AND status = 'completed';
      UPDATE public.contracts SET contract_amount = (r.old_value ->> 'contract_amount')::numeric WHERE id = r.contract_id;
      UPDATE public.contracts SET status = r.old_value ->> 'status' WHERE id = r.contract_id;
      INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
      VALUES (r.contract_id, 'field_updated', 'contract_amount', r.new_value - 'fix',
              (r.old_value - 'updated_at') || jsonb_build_object('fix_rollback', c_fix),
              'Откат исправления 29.10: сумма ДС возвращена прежняя.', c_who);
      RAISE NOTICE 'откат: ID % — сумма %', r.display_id, r.old_value ->> 'contract_amount';
    ELSIF r.event_type = 'soft_deleted' THEN
      UPDATE public.contracts SET deleted_at = NULL WHERE id = r.contract_id AND deleted_at IS NOT NULL;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> 1 THEN RAISE EXCEPTION 'ID %: не восстановлен', r.display_id; END IF;
      INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
      VALUES (r.contract_id, 'restored', 'deleted_at', r.new_value - 'fix' - 'keep',
              jsonb_build_object('deleted_at', NULL, 'fix_rollback', c_fix),
              'Откат исправления 29.10: договор возвращён из «Удалённых».', c_who);
      RAISE NOTICE 'откат: ID % — из «Удаленных»', r.display_id;
    END IF;
  END LOOP;

  -- Проверка «после».
  FOR r IN SELECT l.contract_id, l.event_type, l.old_value, c.display_id
             FROM public.contract_audit_log l JOIN public.contracts c ON c.id = l.contract_id
            WHERE l.new_value ->> 'fix' = c_fix AND l.changed_at = v_at LOOP
    SELECT to_jsonb(c) INTO v_cur FROM public.contracts c WHERE c.id = r.contract_id;
    IF r.event_type = 'field_updated' AND ((v_cur ->> 'contract_amount')::numeric IS DISTINCT FROM (r.old_value ->> 'contract_amount')::numeric
         OR v_cur ->> 'status' IS DISTINCT FROM r.old_value ->> 'status') THEN
      RAISE EXCEPTION 'FAIL ID %: сумма или статус не вернулись', r.display_id;
    END IF;
    IF r.event_type = 'soft_deleted' AND v_cur ->> 'deleted_at' IS NOT NULL THEN
      RAISE EXCEPTION 'FAIL ID %: не вернулся из «Удаленных»', r.display_id;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK: откат сошёлся';
END $$;

\if :apply
COMMIT;
\echo 'Откачено.'
\else
ROLLBACK;
\echo 'Пробный прогон отката: изменения откачены. Откатить — с -v apply=1.'
\endif
