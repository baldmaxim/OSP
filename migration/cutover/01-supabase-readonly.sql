-- Барьер записи в Supabase перед финальной копией (migration/CUTOVER.md, шаг В.1).
-- Выполняется в SQL Editor, в нерабочее время. После него база Supabase только читается:
--   • у вошедших и анонима снимается право менять таблицы напрямую;
--   • у них же снимается право вызывать функции, которые меняют данные (изменяющие, с правами владельца);
--     функции-проверки, которыми пользуются правила чтения, остаются — чтение работает как раньше;
--   • расписание пересчёта реестра расценок снимается.
-- Что было выдано, сохраняется в схеме osp_cutover — по этим записям откат возвращает всё как было
-- (migration/cutover/02-supabase-readonly-rollback.sql). Повторный запуск безопасен. Данные не меняются.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE SCHEMA IF NOT EXISTS osp_cutover;
REVOKE ALL ON SCHEMA osp_cutover FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS osp_cutover.saved_grants (
  kind text NOT NULL, name text NOT NULL, grantee text NOT NULL, privilege text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (kind, name, grantee, privilege));
CREATE TABLE IF NOT EXISTS osp_cutover.saved_cron (jobname text, schedule text NOT NULL, command text NOT NULL, saved_at timestamptz NOT NULL DEFAULT now());

-- Что снимаем: запись в таблицы.
INSERT INTO osp_cutover.saved_grants (kind, name, grantee, privilege)
SELECT 'table', c.oid::regclass::text, a.grantee::regrole::text, a.privilege_type
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
  AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)
  AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
ON CONFLICT DO NOTHING;

-- Что снимаем: вызов изменяющих функций с правами владельца (не триггерных, не из расширений).
INSERT INTO osp_cutover.saved_grants (kind, name, grantee, privilege)
SELECT 'function', p.oid::regprocedure::text, CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, 'EXECUTE'
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
     aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef AND p.provolatile = 'v'
  AND p.prorettype <> 'trigger'::regtype
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  AND a.privilege_type = 'EXECUTE'
  AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole))
ON CONFLICT DO NOTHING;

DO $barrier$
DECLARE
  r record;
BEGIN
  -- Изменяющая функция не должна участвовать в правилах чтения и представлениях: иначе барьер сломал бы чтение.
  FOR r IN SELECT DISTINCT split_part(g.name, '(', 1) AS fn FROM osp_cutover.saved_grants g WHERE g.kind = 'function' LOOP
    IF EXISTS (SELECT 1 FROM pg_policies pp WHERE pp.schemaname = 'public'
                 AND (coalesce(pp.qual, '') || ' ' || coalesce(pp.with_check, '')) ~ ('\m' || r.fn || '\(')
                 AND pp.cmd IN ('SELECT', 'ALL'))
       OR EXISTS (SELECT 1 FROM pg_views v WHERE v.schemaname = 'public' AND v.definition ~ ('\m' || r.fn || '\(')) THEN
      RAISE EXCEPTION 'Изменяющая функция % участвует в правилах чтения — барьер остановлен, ничего не изменено', r.fn;
    END IF;
  END LOOP;

  FOR r IN SELECT DISTINCT name FROM osp_cutover.saved_grants WHERE kind = 'table' LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %s FROM anon, authenticated', r.name);
  END LOOP;
  FOR r IN SELECT DISTINCT name FROM osp_cutover.saved_grants WHERE kind = 'function' LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.name);
  END LOOP;

  -- Расписание (pg_cron): пересчёт реестра пишет в базу.
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE 'INSERT INTO osp_cutover.saved_cron (jobname, schedule, command) SELECT jobname, schedule, command FROM cron.job';
    EXECUTE 'SELECT cron.unschedule(jobid) FROM cron.job';
  END IF;
END
$barrier$;
COMMIT;

-- Проверка: каждая строка — «OK …» или «FAIL …».
SELECT CASE WHEN n = 0 THEN 'OK ' ELSE 'FAIL ' END || what || CASE WHEN n = 0 THEN '' ELSE ': ' || n END
FROM (
  SELECT 1 AS ord, 'вошедший и аноним не могут менять таблицы напрямую' AS what,
         (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p', 'v')
            AND (has_table_privilege('authenticated', c.oid, 'INSERT') OR has_table_privilege('authenticated', c.oid, 'UPDATE')
              OR has_table_privilege('authenticated', c.oid, 'DELETE') OR has_table_privilege('anon', c.oid, 'INSERT')
              OR has_table_privilege('anon', c.oid, 'UPDATE') OR has_table_privilege('anon', c.oid, 'DELETE'))) AS n
  UNION ALL
  SELECT 2, 'вошедший и аноним не могут вызвать изменяющие функции',
         (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
          WHERE ns.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef AND p.provolatile = 'v' AND p.prorettype <> 'trigger'::regtype
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
            AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')))
  UNION ALL
  SELECT 3, 'чтение сохранено: у вошедшего осталось право читать таблицы',
         CASE WHEN (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND has_table_privilege('authenticated', c.oid, 'SELECT')) > 0
              THEN 0 ELSE 1 END
  UNION ALL
  SELECT 4, 'расписаний, пишущих в базу, не осталось',
         CASE WHEN to_regclass('cron.job') IS NULL THEN 0
              ELSE (xpath('/row/n/text()', query_to_xml('select count(*) as n from cron.job', false, true, '')))[1]::text::bigint END
) checks ORDER BY ord;
