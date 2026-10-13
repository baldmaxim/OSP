-- Снять барьер записи в Supabase — вернуть всё, что сняло 01-supabase-readonly.sql.
-- СЕЙЧАС НЕ ВЫПОЛНЯТЬ — только при откате переключения до первой записи в базу Яндекса
-- (migration/CUTOVER.md). Возвращает ровно сохранённые права и расписания; повторный запуск безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $rollback$
DECLARE
  r record;
BEGIN
  IF to_regclass('osp_cutover.saved_grants') IS NULL THEN
    RAISE EXCEPTION 'Сохранённых прав нет: барьер не ставился';
  END IF;
  FOR r IN SELECT kind, name, grantee, string_agg(privilege, ', ' ORDER BY privilege) AS privs
           FROM osp_cutover.saved_grants GROUP BY kind, name, grantee LOOP
    EXECUTE format('GRANT %s ON %s %s TO %s', r.privs, CASE r.kind WHEN 'function' THEN 'FUNCTION' ELSE 'TABLE' END, r.name,
                   CASE r.grantee WHEN 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r.grantee) END);
  END LOOP;
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOR r IN SELECT DISTINCT ON (schedule, command) jobname, schedule, command FROM osp_cutover.saved_cron LOOP
      IF r.jobname IS NULL THEN
        EXECUTE format('SELECT cron.schedule(%L, %L)', r.schedule, r.command);
      ELSE
        EXECUTE format('SELECT cron.schedule(%L, %L, %L)', r.jobname, r.schedule, r.command);
      END IF;
    END LOOP;
  END IF;
  DROP SCHEMA osp_cutover CASCADE;
END
$rollback$;
COMMIT;
