-- Откат migration/data/20261103_contracts_tender_links.sql по журналу «История» (contract_audit_log, отметка fix): у договоров этой
-- правки тендер снова пуст. Договор, у которого тендер с тех пор сменили руками, не трогается — число в выводе. В журнал —
-- запись об откате.
--
-- По умолчанию — ПРОБНЫЙ прогон (ROLLBACK); откатить — с -v apply=1. В нерабочее время:
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X [-v apply=1] -f migration/data/20261103_contracts_tender_links_rollback.sql )
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
  c_fix constant text := '20261103_contracts_tender_links';
  c_who constant text := 'Откат исправления данных 03.11.2026 (скрипт)';
  j record; n_back int := 0; n_kept int := 0;
BEGIN
  FOR j IN
    SELECT x.contract_id, (x.new_value ->> 'tender_id')::uuid AS tid
      FROM public.contract_audit_log x
     WHERE x.new_value ->> 'fix' = c_fix
       AND NOT EXISTS (SELECT 1 FROM public.contract_audit_log z WHERE z.contract_id = x.contract_id
                         AND z.new_value ->> 'fix_rollback' = c_fix AND z.changed_at > x.changed_at)
  LOOP
    UPDATE public.contracts SET tender_id = NULL WHERE id = j.contract_id AND tender_id = j.tid;
    IF NOT FOUND THEN n_kept := n_kept + 1; CONTINUE; END IF;
    INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_name)
    VALUES (j.contract_id, 'field_updated', 'tender_id', jsonb_build_object('tender_id', j.tid),
            jsonb_build_object('tender_id', NULL, 'fix_rollback', c_fix), 'Привязка к тендеру снята: откат исправления данных.', c_who);
    n_back := n_back + 1;
  END LOOP;
  RAISE NOTICE 'откат: тендер снят у %, тендер уже сменили руками у %', n_back, n_kept;
END $$;

\if :apply
COMMIT;
\echo 'Откачено.'
\else
ROLLBACK;
\echo 'Пробный прогон: изменения откачены. Откатить — с -v apply=1.'
\endif
