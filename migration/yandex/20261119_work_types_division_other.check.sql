-- После 20261119_work_types_division_other: у видов работ есть «Прочее» (other), видов без подразделения не осталось;
-- правила по строкам на месте. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой
-- служебной операции.
with
checks(n, ok, what) as (
  select 1, exists (select 1 from pg_constraint where conrelid = 'public.work_types'::regclass
                      and conname = 'work_types_division_check'
                      and pg_get_constraintdef(oid) like '%finishing%' and pg_get_constraintdef(oid) like '%''other''%'),
         'подразделение — коды подразделений ВОР и «Прочее» (other)'
  union all
  select 2, not exists (select 1 from public.work_types where division is null),
         'видов работ без подразделения: ' || (select count(*) from public.work_types where division is null)
         || '; «Прочее»: ' || (select count(*) from public.work_types where division = 'other')
         || ' из ' || (select count(*) from public.work_types)
  union all
  select 3, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.work_types'::regclass),
         'work_types: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
