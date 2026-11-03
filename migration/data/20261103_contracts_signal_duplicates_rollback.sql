-- Откат migration/data/20261103_contracts_signal_duplicates.sql по журналу «История» (contract_audit_log, отметка fix): записи от
-- 30.10 и их пустые ДС — из «Удаленных», перенесённые ДС — обратно, поля старых записей — как было.
-- Что менялось после правки, не перетирается: поле возвращается, только если в нём всё ещё значение правки; ДС — только если
-- всё ещё у старого договора; иначе — сообщение в выводе и значение остаётся. Журнал не чистится: добавляются записи с fix_rollback.
--
-- По умолчанию — ПРОБНЫЙ прогон (ROLLBACK); откатить — с -v apply=1. В нерабочее время:
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X [-v apply=1] -f migration/data/20261103_contracts_signal_duplicates_rollback.sql )
\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_catalog.set_config('application_name', 'osp:internal', true) \gset ignored_

DO $$
DECLARE
  c_fix constant text := '20261103_contracts_signal_duplicates';
  c_who constant text := 'Откат исправления данных 03.11.2026 (скрипт)';
  j record; e jsonb; k public.contracts; v_keep uuid; v_kids uuid[]; v_cur jsonb; v_stale boolean; v_field text; v_protected boolean; v_was_completed boolean;
  n_pairs int := 0; n_back int := 0; n_stale int := 0;
BEGIN
  -- С последней пары к первой.
  FOR j IN
    SELECT x.contract_id AS dup, x.old_value AS o, x.new_value AS v, (x.new_value ->> 'seq')::int AS seq
      FROM public.contract_audit_log x
     WHERE x.event_type = 'soft_deleted' AND x.new_value ->> 'fix' = c_fix AND x.new_value ? 'k_before'
       AND NOT EXISTS (SELECT 1 FROM public.contract_audit_log z WHERE z.contract_id = x.contract_id
                         AND z.new_value ->> 'fix_rollback' = c_fix AND z.changed_at > x.changed_at)
     ORDER BY (x.new_value ->> 'seq')::int DESC
  LOOP
    v_keep := (j.v ->> 'keep_id')::uuid;
    n_pairs := n_pairs + 1;

    -- Запись от 30.10 — обратно.
    UPDATE public.contracts SET deleted_at = NULL, notes = j.o ->> 'notes' WHERE id = j.dup;

    -- Перенесённые ДС — под прежний договор.
    FOR e IN SELECT x FROM jsonb_array_elements(j.v -> 'kids_moved') x LOOP
      IF EXISTS (SELECT 1 FROM public.contracts c WHERE c.id = (e ->> 'id')::uuid AND c.parent_contract_id = v_keep) THEN
        UPDATE public.contracts SET status = 'in_work' WHERE id = (e ->> 'id')::uuid;
        UPDATE public.contracts SET parent_contract_id = j.dup, status = 'completed' WHERE id = (e ->> 'id')::uuid;
        INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, new_value, description, changed_by_name)
        VALUES ((e ->> 'id')::uuid, 'field_updated', 'parent_contract_id', jsonb_build_object('fix_rollback', c_fix), 'Откат: ДС возвращено к прежней записи договора.', c_who);
        n_back := n_back + 1;
      ELSE
        n_stale := n_stale + 1;
        RAISE NOTICE 'оставлено: ДС % уже не у договора', e ->> 'id';
      END IF;
    END LOOP;

    -- Пустые записи ДС — из «Удаленных»; ссылка Signal у ДС договора — как было.
    FOR e IN SELECT x FROM jsonb_array_elements(j.v -> 'kids_deleted') x LOOP
      UPDATE public.contracts SET deleted_at = NULL WHERE id = (e ->> 'id')::uuid;
      UPDATE public.contracts SET signal_link = e ->> 'into_signal_before' WHERE id = (e ->> 'into')::uuid AND signal_link IS NOT DISTINCT FROM e ->> 'into_signal_after';
      INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, new_value, description, changed_by_name)
      VALUES ((e ->> 'id')::uuid, 'restored', 'deleted_at', jsonb_build_object('fix_rollback', c_fix), 'Откат: запись ДС возвращена из «Удалённых».', c_who);
      n_back := n_back + 1;
    END LOOP;

    -- Старая запись: только поля, в которых всё ещё значение правки.
    SELECT * INTO k FROM public.contracts WHERE id = v_keep;
    v_cur := jsonb_build_object('signal_link', k.signal_link, 'email', k.email, 'phone', k.phone, 'gen_director_name', k.gen_director_name, 'comments', k.comments,
      'contract_amount', k.contract_amount, 'vat_rate', k.vat_rate, 'bsm', k.bsm, 'work_start_date', k.work_start_date, 'work_end_date', k.work_end_date);
    v_protected := false;
    FOR v_field IN SELECT jsonb_object_keys(v_cur) LOOP
      IF j.v -> 'k_after' -> v_field IS DISTINCT FROM j.v -> 'k_before' -> v_field THEN
        IF v_cur -> v_field IS DISTINCT FROM j.v -> 'k_after' -> v_field THEN
          n_stale := n_stale + 1;
          RAISE NOTICE 'оставлено: поле % договора % изменено после правки', v_field, k.display_id;
        ELSE
          v_cur := jsonb_set(v_cur, ARRAY[v_field], j.v -> 'k_before' -> v_field);
          IF v_field IN ('contract_amount', 'vat_rate', 'bsm', 'work_start_date', 'work_end_date') THEN v_protected := true; END IF;
        END IF;
      END IF;
    END LOOP;
    UPDATE public.contracts SET signal_link = v_cur ->> 'signal_link', email = v_cur ->> 'email', phone = v_cur ->> 'phone',
           gen_director_name = v_cur ->> 'gen_director_name', comments = v_cur ->> 'comments' WHERE id = v_keep;
    IF v_protected THEN
      v_was_completed := k.status = 'completed';
      IF v_was_completed THEN
        SELECT array_agg(c.id) INTO v_kids FROM public.contracts c WHERE c.parent_contract_id = v_keep AND c.deleted_at IS NULL;
        UPDATE public.contracts SET deleted_at = now() WHERE id = ANY (v_kids);
        UPDATE public.contracts SET status = 'in_work' WHERE id = v_keep;
      END IF;
      UPDATE public.contracts SET contract_amount = (v_cur ->> 'contract_amount')::numeric, vat_rate = (v_cur ->> 'vat_rate')::numeric, bsm = v_cur ->> 'bsm',
             work_start_date = (v_cur ->> 'work_start_date')::date, work_end_date = (v_cur ->> 'work_end_date')::date WHERE id = v_keep;
      IF v_was_completed THEN
        UPDATE public.contracts SET status = 'completed' WHERE id = v_keep;
        UPDATE public.contracts SET deleted_at = NULL WHERE id = ANY (v_kids);
      END IF;
    END IF;

    INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, new_value, description, changed_by_name)
    VALUES (j.dup, 'restored', 'deleted_at', jsonb_build_object('fix_rollback', c_fix), 'Откат: запись возвращена из «Удалённых».', c_who),
           (v_keep, 'field_updated', NULL, jsonb_build_object('fix_rollback', c_fix), 'Откат: поля, заполненные при объединении с дублем, возвращены.', c_who);
  END LOOP;
  IF n_pairs = 0 THEN RAISE EXCEPTION 'Откатывать нечего: в журнале нет действующих записей правки'; END IF;
  RAISE NOTICE 'откат: пар %, строк ДС возвращено %, значений оставлено %', n_pairs, n_back, n_stale;
  RAISE NOTICE 'OK';
END $$;

\if :apply
COMMIT;
\echo 'Откат применён.'
\else
ROLLBACK;
\echo 'Пробный прогон отката: изменения откачены. Применить — с -v apply=1.'
\endif
