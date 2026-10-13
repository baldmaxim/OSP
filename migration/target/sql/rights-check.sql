-- Проверка прав под одну учётку (rights.sh, rights.sh --check). Только чтение; строки «OK …» / «FAIL …».
-- Последние проверки — «вживую»: в откатываемой транзакции учётка без отметки пропуска и без токена
-- читает таблицы и не должна увидеть ни строки.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SELECT set_config('search_path', 'public', true);
WITH t AS (
  SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
), pol AS (
  SELECT c.relname, p.polname, regexp_replace(pg_get_expr(p.polqual, p.polrelid), '\s+', ' ', 'g') AS qual,
         regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '\s+', ' ', 'g') AS chk
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
), fn AS (
  SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') ~ 'application_name=osp:internal' AS marked
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
), checks(n, ok, what) AS (
  SELECT 1, (SELECT count(*) FROM t WHERE NOT (relrowsecurity AND relforcerowsecurity)) = 0,
         'правила по строкам включены и действуют на владельца у всех таблиц: ' || (SELECT count(*) FROM t)
  UNION ALL
  SELECT 2, (SELECT count(*) FROM t WHERE NOT EXISTS (SELECT 1 FROM pol WHERE pol.relname = t.relname AND pol.polname = 'osp_internal')) = 0,
         'у каждой таблицы есть пропуск для служебных функций'
  UNION ALL
  SELECT 3, (SELECT count(*) FROM pol WHERE polname <> 'osp_internal') = (SELECT count(*) FROM osp_meta.policy_roles),
         'политик из копии: ' || (SELECT count(*) FROM osp_meta.policy_roles) || ', в базе столько же'
  UNION ALL
  SELECT 4, (SELECT count(*) FROM pol WHERE polname <> 'osp_internal'
               AND (coalesce(qual, chk) IS NULL
                 OR coalesce(qual, ' CASE WHEN ( SELECT osp_private.bypass() AS bypass) THEN true ELSE (( SELECT osp_private.role_in(') !~ '^ ?CASE WHEN \( SELECT osp_private\.bypass\(\) AS bypass\) THEN true ELSE \(\( SELECT osp_private\.role_in\('
                 OR coalesce(chk, ' CASE WHEN ( SELECT osp_private.bypass() AS bypass) THEN true ELSE (( SELECT osp_private.role_in(') !~ '^ ?CASE WHEN \( SELECT osp_private\.bypass\(\) AS bypass\) THEN true ELSE \(\( SELECT osp_private\.role_in\(')) = 0,
         'каждая политика проверяет роль из токена и не вычисляется при пропуске'
  UNION ALL
  SELECT 5, (SELECT count(*) FROM fn WHERE prosecdef <> marked) = 0,
         'отметка пропуска — у всех служебных функций (' || (SELECT count(*) FROM fn WHERE prosecdef) || ') и только у них'
  UNION ALL
  SELECT 6, (SELECT count(*) FROM pg_matviews WHERE schemaname = 'public') = 0,
         'материализованных представлений в открытой схеме нет (в закрытой — ' || (SELECT count(*) FROM pg_matviews WHERE schemaname = 'osp_private') || ')'
  UNION ALL
  SELECT 7, (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind = 'v' AND (pg_relation_is_updatable(c.oid, false) & 28) <> 0
               AND (SELECT count(*) FROM pg_rewrite r WHERE r.ev_class = c.oid AND r.is_instead
                      AND r.rulename IN ('osp_readonly_insert', 'osp_readonly_update', 'osp_readonly_delete')) <> 3) = 0,
         'через представления записать нельзя'
  UNION ALL
  SELECT 8, (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'auth.users'::regclass)
            AND (SELECT count(*) FROM pg_policy WHERE polrelid = 'auth.users'::regclass) = 1,
         'копия учёток закрыта: только служебным функциям'
  UNION ALL
  SELECT 9, to_regprocedure('osp_private.pre_request()') IS NOT NULL AND has_schema_privilege('public', 'osp_private', 'USAGE') IS FALSE,
         'закрытая схема: проверка начала запроса на месте, «всем» схема недоступна'
)
SELECT CASE WHEN ok THEN 'OK ' ELSE 'FAIL ' END || what FROM checks ORDER BY n;

-- Вживую: без отметки пропуска и без токена (как запрос мимо шлюза) — ни одной строки ни в одной таблице.
SELECT set_config('application_name', 'osp-rights-check', true), set_config('request.jwt.claims', '', true),
       set_config('request.jwt.claim.role', '', true), set_config('request.jwt.claim.sub', '', true) \gset ignored_
DO $live$
DECLARE
  r record;
  n bigint;
  v_open text := '';
  v_showcase text := '';
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
           WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p', 'v') AND NOT c.relispartition ORDER BY 1 LOOP
    EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM public.%I LIMIT 1) x', r.relname) INTO n;
    IF n > 0 THEN
      -- Публичная витрина: анониму правилами открыта часть строк этих таблиц.
      IF EXISTS (SELECT 1 FROM osp_meta.policy_roles pr WHERE pr.table_name = r.relname AND 'anon' = ANY (pr.roles)) THEN
        v_showcase := v_showcase || ' ' || r.relname;
      ELSE
        v_open := v_open || ' ' || r.relname;
      END IF;
    END IF;
  END LOOP;
  PERFORM set_config('osp_check.open', v_open, true), set_config('osp_check.showcase', v_showcase, true);
END
$live$;
SELECT CASE WHEN current_setting('osp_check.open') = '' THEN 'OK ' ELSE 'FAIL ' END
       || 'без токена и без пропуска строки видны только в таблицах публичной витрины:' || current_setting('osp_check.showcase')
       || CASE WHEN current_setting('osp_check.open') = '' THEN '' ELSE '; ЛИШНЕЕ:' || current_setting('osp_check.open') END;
ROLLBACK;
