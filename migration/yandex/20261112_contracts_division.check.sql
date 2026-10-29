-- После 20261112_contracts_division: у договоров — подразделение (коды подразделений ВОР); правила по строкам на месте.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
checks(n, ok, what) as (
  select 1, exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'contracts' and column_name = 'division' and data_type = 'text'),
         'contracts: division (text)'
  union all
  select 2, exists (select 1 from pg_constraint where conrelid = 'public.contracts'::regclass
                      and conname = 'contracts_division_check' and pg_get_constraintdef(oid) like '%finishing%'),
         'подразделение — только коды подразделений ВОР'
  union all
  select 3, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.contracts'::regclass),
         'contracts: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
