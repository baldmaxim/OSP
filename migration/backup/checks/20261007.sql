-- После 20261007: таблицы телеметрии есть, RLS включён, права как задуманы.
-- Строки «OK …» / «FAIL …»; только чтение. В SQL Editor все строки должны начинаться с OK.
-- CASE — чтобы проверка прав не падала, если объекта нет (тогда строка FAIL).
with t(name, rel) as (
  select n, to_regclass('public.' || n) from (values ('client_versions'), ('client_errors')) v(n)
),
f(sig, fn) as (
  select s, to_regprocedure(s) from (values ('public.report_client_version(text)'),
                                            ('public.report_client_error(text,text,text,integer)')) v(s)
),
checks(ok, what) as (
  select coalesce((select c.relrowsecurity from pg_class c where c.oid = t.rel), false),
         t.name || ': таблица есть, RLS включён'
  from t
  union all
  select case when t.rel is null then false
              else has_table_privilege('authenticated', t.rel, 'SELECT')
                   and not has_table_privilege('authenticated', t.rel, 'INSERT,UPDATE,DELETE,TRUNCATE') end,
         t.name || ': authenticated — только SELECT (строки отдаёт политика администратора)'
  from t
  union all
  select case when t.rel is null then false
              else not has_table_privilege('anon', t.rel, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') end,
         t.name || ': anon и PUBLIC — без прав'
  from t
  union all
  select case when t.rel is null then false
              else exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.name and p.cmd = 'SELECT')
                   and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.name and p.cmd <> 'SELECT') end,
         t.name || ': политики только на чтение'
  from t
  union all
  select case when f.fn is null then false
              else coalesce((select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
                             from pg_proc p where p.oid = f.fn), false)
                   and has_function_privilege('authenticated', f.fn, 'EXECUTE')
                   and not has_function_privilege('anon', f.fn, 'EXECUTE') end,
         f.sig || ': SECURITY DEFINER, search_path закреплён, EXECUTE только у authenticated'
  from f
)
select case when ok then 'OK ' else 'FAIL ' end || what from checks order by what;
