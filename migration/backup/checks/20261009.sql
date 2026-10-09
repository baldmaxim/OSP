-- После 20261009: employee_directory только на чтение. Строки «OK …» / «FAIL …»; только чтение.
with v(rel) as (select 'public.employee_directory'::regclass)
select line from (
  select 1, case when has_table_privilege('authenticated', rel, 'SELECT') then 'OK' else 'FAIL' end
            || ' employee_directory: чтение у authenticated осталось' from v
  union all
  select 2, case when not has_table_privilege('authenticated', rel, 'INSERT,UPDATE,DELETE,TRUNCATE') then 'OK' else 'FAIL' end
            || ' employee_directory: authenticated не может писать' from v
  union all
  select 3, case when not has_table_privilege('anon', rel, 'INSERT,UPDATE,DELETE,TRUNCATE') then 'OK' else 'FAIL' end
            || ' employee_directory: anon и PUBLIC не могут писать' from v
) s(n, line) order by n;
