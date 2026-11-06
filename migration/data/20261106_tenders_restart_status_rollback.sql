-- Откат migration/data/20261106_tenders_restart_status.sql: тендерам, которым скрипт поставил «Перезапуск», вернуть прежний статус.
-- Прежний статус — из записи журнала «История» тендера, которую оставил скрипт (changed_by_name, old_value). Тендер, у которого
-- статус после скрипта уже меняли (сейчас не «Перезапуск»), не трогается — сообщение. В историю — запись об откате.
--
-- По умолчанию — пробный прогон (ROLLBACK), применить — с -v apply=1. Запуск — как у самой правки, в нерабочее время:
--   ( source migration/target/lib/conn.sh && target_conn ~/.osp-secrets/target.env \
--     && target_pin_check ~/.osp-secrets/target.env \
--     && psql -X -v apply=1 -f migration/data/20261106_tenders_restart_status_rollback.sql )
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
  c_fix_who constant text := 'Исправление данных 06.11.2026 (скрипт)';
  c_who constant text := 'Откат исправления данных 06.11.2026 (скрипт)';
  c_status constant text := 'Перезапуск';
  p record; n_done int := 0; n_skip int := 0;
BEGIN
  FOR p IN
    SELECT DISTINCT ON (j.tender_id) j.tender_id, j.old_value #>> '{}' AS old_status, t.status AS cur_status, t.public_tender_number AS num
      FROM public.tender_audit_log j JOIN public.tenders t ON t.id = j.tender_id
     WHERE j.changed_by_name = c_fix_who AND j.event_type = 'status_changed' AND j.new_value #>> '{}' = c_status
     ORDER BY j.tender_id, j.changed_at DESC
  LOOP
    IF p.cur_status IS DISTINCT FROM c_status THEN
      n_skip := n_skip + 1;
      RAISE NOTICE 'пропуск: № %: статус уже сменили («%»)', p.num, p.cur_status;
      CONTINUE;
    END IF;
    UPDATE public.tenders SET status = p.old_status WHERE id = p.tender_id;
    INSERT INTO public.tender_audit_log (tender_id, event_type, field_name, old_value, new_value, description, changed_by_name)
    VALUES (p.tender_id, 'status_changed', NULL, to_jsonb(c_status), to_jsonb(p.old_status),
            format('Статус: %s → %s (откат правки 06.11.2026)', c_status, coalesce(p.old_status, '—')), c_who);
    n_done := n_done + 1;
    RAISE NOTICE 'возвращён: № % → «%»', p.num, p.old_status;
  END LOOP;
  RAISE NOTICE 'откат: возвращено %, пропущено %', n_done, n_skip;
END $$;

\if :apply
COMMIT;
\echo 'Применено.'
\else
ROLLBACK;
\echo 'Пробный прогон: изменения откачены. Применить — с -v apply=1.'
\endif
