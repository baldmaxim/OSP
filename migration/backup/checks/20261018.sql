-- Проверка после 20261018_larix_contract_rates.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
with
t as (
  select c.oid, c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname in ('larix_contract_rates', 'larix_sync_runs', 'larix_sync_stage')
),
fn as (
  select p.oid, p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('larix_sync_begin', 'larix_sync_add_rows', 'larix_sync_finish', 'larix_sync_fail')
),
checks(n, ok, what) as (
  select 1, (select count(*) from t) = 3 and (select bool_and(relrowsecurity) from t),
         'три таблицы Larix созданы, RLS включён'
  union all
  select 2, not has_table_privilege('anon', 'public.larix_contract_rates', 'select')
            and not has_table_privilege('anon', 'public.larix_sync_runs', 'select')
            and not has_table_privilege('anon', 'public.larix_sync_stage', 'select'),
         'гость не читает ни реестр Larix, ни журнал, ни порции'
  union all
  select 3, has_table_privilege('authenticated', 'public.larix_contract_rates', 'select')
            and has_table_privilege('authenticated', 'public.larix_sync_runs', 'select')
            and not has_table_privilege('authenticated', 'public.larix_sync_stage', 'select')
            and not has_table_privilege('authenticated', 'public.larix_contract_rates', 'insert,update,delete')
            and not has_table_privilege('authenticated', 'public.larix_sync_runs', 'insert,update,delete'),
         'вошедшему — только чтение реестра и журнала (строки — по праву раздела), порции закрыты'
  union all
  select 4, (select count(*) from pg_policies where schemaname = 'public' and tablename like 'larix\_%') = 2
            and (select bool_and(cmd = 'SELECT' and roles = '{authenticated}' and qual like '%osp_can(%rates_registry%view%')
                 from pg_policies where schemaname = 'public' and tablename like 'larix\_%'),
         'политики чтения Larix: только SELECT, только с правом раздела «Реестр расценок»'
  union all
  select 5, (select count(*) from fn) = 4 and not (select bool_or(prosecdef) from fn),
         'четыре функции загрузки, не SECURITY DEFINER'
  union all
  select 6, not (select bool_or(has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute')) from fn)
            and (select bool_and(has_function_privilege('service_role', oid, 'execute')) from fn),
         'функции загрузки вызывает только служебный ключ (service_role)'
  union all
  select 7, (select count(*) from public.larix_sync_runs where status = 'running') <= 1,
         'журнал загрузок читается, незавершённых загрузок не больше одной'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
