-- Проверка после Р2d (20261013_r2d_rates_registry_employee_only.sql). Каждая строка — «OK …» или
-- «FAIL …». Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
with v(name) as (values ('kp_rates_registry'), ('kp_rates_registry_filter_counterparties'), ('kp_rates_registry_filter_objects'), ('kp_rates_registry_filter_tenders'), ('kp_rates_registry_units'), ('supply_rates_registry'), ('supply_rates_registry_filter_objects'), ('supply_rates_registry_filter_tenders'), ('supply_rates_registry_units')),
checks(n, ok, what) as (
  select 1, (select count(*) from v join pg_views pv on pv.schemaname = 'public' and pv.viewname = v.name
             where pv.definition ~ 'osp_registry_reader') = 9,
         'все девять представлений реестра отдают строки только читателю реестра'
  union all
  select 2, not has_table_privilege('authenticated', 'public.kp_rates_registry_mv', 'SELECT')
        and not has_table_privilege('authenticated', 'public.supply_rates_registry_mv', 'SELECT')
        and not has_table_privilege('anon', 'public.kp_rates_registry_mv', 'SELECT')
        and not has_table_privilege('anon', 'public.supply_rates_registry_mv', 'SELECT'),
         'материализованные представления напрямую не читают ни вошедший, ни аноним'
  union all
  select 3, has_table_privilege('service_role', 'public.kp_rates_registry_mv', 'SELECT')
        and has_table_privilege('service_role', 'public.supply_rates_registry_mv', 'SELECT'),
         'служебный ключ читает материализованные представления (выдача смежному отделу)'
  union all
  select 4, (select bool_and(has_table_privilege('authenticated', 'public.' || name, 'SELECT')
                             and not has_table_privilege('authenticated', 'public.' || name, 'INSERT')
                             and not has_table_privilege('anon', 'public.' || name, 'SELECT')) from v),
         'представления реестра: вошедшему — только чтение, анониму — ничего'
  union all
  select 5, (select p.prosecdef from pg_proc p where p.oid = 'public.osp_registry_reader()'::regprocedure)
        and has_function_privilege('authenticated', 'public.osp_registry_reader()', 'EXECUTE')
        and has_function_privilege('service_role', 'public.osp_registry_reader()', 'EXECUTE')
        and not has_function_privilege('anon', 'public.osp_registry_reader()', 'EXECUTE')
        and not has_function_privilege('public', 'public.osp_registry_reader()', 'EXECUTE'),
         'osp_registry_reader: SECURITY DEFINER, вызывают вошедший и служебный ключ, аноним — нет'
  union all
  select 6, not has_function_privilege('anon', 'public.refresh_rates_registry()', 'EXECUTE')
        and not has_function_privilege('public', 'public.refresh_rates_registry()', 'EXECUTE')
        and has_function_privilege('authenticated', 'public.refresh_rates_registry()', 'EXECUTE'),
         'пересчёт реестра без входа не вызывается'
  union all
  select 7, (select pg_get_functiondef('public.refresh_rates_registry()'::regprocedure) ~ 'osp_is_employee'
                and pg_get_functiondef('public.refresh_rates_registry()'::regprocedure) ~ '60 seconds'),
         'пересчёт реестра: только сотрудник, не чаще раза в минуту'
  union all
  select 8, (select count(*) from public.kp_rates_registry_mv) >= 0 and (select count(*) from public.supply_rates_registry_mv) >= 0,
         'материализованные представления на месте и читаются владельцем'
)
select case when ok then 'OK ' else 'FAIL ' end || what from checks order by n;
