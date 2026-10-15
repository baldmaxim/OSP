-- После 20261018_larix_contract_rates: таблицы договорных расценок Larix, функции загрузки и права под
-- одну учётку. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой
-- служебной операции.
with
t as (
  select c.relname, c.relrowsecurity and c.relforcerowsecurity as forced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('larix_contract_rates', 'larix_sync_runs', 'larix_sync_stage') and c.relkind = 'r'
),
pol as (
  select tablename, policyname, cmd, qual from pg_policies
  where schemaname = 'public' and tablename in ('larix_contract_rates', 'larix_sync_runs', 'larix_sync_stage')
),
fn as (
  select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('larix_sync_begin', 'larix_sync_add_rows', 'larix_sync_finish', 'larix_sync_fail')
),
checks(n, ok, what) as (
  select 1, (select count(*) from t) = 3 and (select bool_and(forced) from t),
         'три таблицы Larix: правила по строкам включены и действуют на владельца'
  union all
  select 2, (select count(*) from pol where policyname = 'osp_internal') = 3,
         'у каждой таблицы Larix — пропуск служебных операций'
  union all
  select 3, (select count(*) from pol where policyname <> 'osp_internal') = 2
            and exists (select 1 from pol where tablename = 'larix_contract_rates' and policyname = 'larix_contract_rates_read'
                          and cmd = 'SELECT' and qual like '%role_in(%authenticated%' and qual like '%osp_can(%rates_registry%view%')
            and exists (select 1 from pol where tablename = 'larix_sync_runs' and policyname = 'larix_sync_runs_read'
                          and cmd = 'SELECT' and qual like '%role_in(%authenticated%' and qual like '%osp_can(%rates_registry%view%'),
         'реестр и журнал Larix читает только вошедший с правом раздела «Реестр расценок»; порции — никто'
  union all
  select 4, (select count(*) from osp_meta.policy_roles
             where schema_name = 'public' and table_name like 'larix\_%' and roles = array['authenticated']) = 2,
         'записи о ролях политик чтения Larix'
  union all
  select 5, (select count(*) from fn) = 4 and not (select bool_or(prosecdef) from fn),
         'четыре функции загрузки Larix — не служебные (вызывает только osp-api служебной операцией)'
  union all
  select 6, to_regclass('public.larix_sync_runs_one_running') is not null,
         'одна загрузка одновременно (уникальный индекс на running)'
  union all
  select 7, (select count(*) from public.larix_sync_runs where status = 'running') <= 1,
         'журнал загрузок Larix читается, незавершённых загрузок не больше одной'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
