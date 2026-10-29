-- После 20261115_work_types_division: у видов работ — подразделение (коды подразделений ВОР); правила по строкам на месте.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
checks(n, ok, what) as (
  select 1, exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'work_types' and column_name = 'division' and data_type = 'text'),
         'work_types: division (text)'
  union all
  select 2, exists (select 1 from pg_constraint where conrelid = 'public.work_types'::regclass
                      and conname = 'work_types_division_check' and pg_get_constraintdef(oid) like '%finishing%'),
         'подразделение — только коды подразделений ВОР'
  union all
  select 3, (select count(*) from public.work_types where division is not null) > 0,
         'начальное распределение: видов с подразделением ' || (select count(*) from public.work_types where division is not null)
         || ' из ' || (select count(*) from public.work_types)
  union all
  select 4, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.work_types'::regclass),
         'work_types: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
