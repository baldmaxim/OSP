-- После 20261211_contracts_estimat_status: у договоров и ДС — отметка Estimat из трёх состояний; данные не тронуты.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
col as (
  select column_name, data_type, is_nullable, column_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'contracts'
    and column_name in ('estimat_status', 'estimat_status_at', 'estimat_status_by')
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where column_name = 'estimat_status' and data_type = 'text'
                    and is_nullable = 'NO' and column_default like '''none''%'),
         'contracts.estimat_status: text, NOT NULL, по умолчанию none'
  union all
  select 2, exists (select 1 from col where column_name = 'estimat_status_at' and data_type = 'timestamp with time zone')
            and exists (select 1 from col where column_name = 'estimat_status_by' and data_type = 'text'),
         'contracts.estimat_status_at (timestamptz) и estimat_status_by (text)'
  union all
  select 3, exists (select 1 from pg_constraint where conrelid = 'public.contracts'::regclass
                      and conname = 'contracts_estimat_status_check'
                      and pg_get_constraintdef(oid) like '%uploaded%' and pg_get_constraintdef(oid) like '%skip%'),
         'отметка Estimat — только none, uploaded, skip'
  union all
  select 4, not exists (select 1 from public.contracts where estimat_status <> 'none'),
         'contracts: отметок Estimat ещё нет — данные не изменились'
  union all
  select 5, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.contracts'::regclass),
         'contracts: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
