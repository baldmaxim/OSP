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
  -- to_regprocedure: до миграции функции нет — строка должна быть FAIL, а не ошибка запроса
  -- (restore-copy.sh по этой проверке решает, применена ли миграция в копии).
  select 5, coalesce((select p.prosecdef
                        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
                        and has_function_privilege('service_role', p.oid, 'EXECUTE')
                        and not has_function_privilege('anon', p.oid, 'EXECUTE')
                        and not has_function_privilege('public', p.oid, 'EXECUTE')
                      from pg_proc p where p.oid = to_regprocedure('public.osp_registry_reader()')), false),
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
  -- По каталогу, без чтения строк: на слепке схемы без данных представления не наполнены.
  select 8, (select count(*) from pg_matviews where schemaname = 'public'
               and matviewname in ('kp_rates_registry_mv', 'supply_rates_registry_mv')) = 2,
         'материализованные представления реестра на месте'
)
select case when ok then 'OK ' else 'FAIL ' end || what from checks order by n;
