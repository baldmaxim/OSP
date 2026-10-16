-- Проверка после Р2g (20261014_r2g_functions_no_anon.sql). Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
with f(sig) as (select unnest(array['public.admin_delete_user(uuid)', 'public.can_see_task(uuid)', 'public.current_counterparty_id()', 'public.is_admin()', 'public.is_my_contract(uuid)', 'public.is_my_tender(uuid)', 'public.is_negotiation_employee()', 'public.is_portal_employee()', 'public.is_task_participant(uuid)', 'public.kp_norm_name(text)', 'public.kp_norm_unit(text)', 'public.psdc_cell_value(jsonb)', 'public.psdc_feature_started_at()', 'public.psdc_norm_header(text)', 'public.psdc_number_message(text, text, text)', 'public.psdc_parse_decimal(jsonb)', 'public.refresh_rates_registry()', 'public.touch_last_login()', 'public.vor_requests_can_access()'])),
callable as (
  -- Функции портала, которые можно вызвать напрямую (не триггерные, не из расширений).
  select p.oid, p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
),
checks(n, ok, what) as (
  select 1, (select count(*) from callable where has_function_privilege('anon', oid, 'EXECUTE')) = 0,
         'без входа не вызывается ни одна функция портала'
         || coalesce(' — остались: ' || (select string_agg(proname, ', ' order by proname) from callable where has_function_privilege('anon', oid, 'EXECUTE')), '')
  union all
  select 2, (select bool_and(not has_function_privilege('public', sig::regprocedure, 'EXECUTE')) from f),
         'у 19 функций право «всем» (PUBLIC) снято'
  union all
  select 3, (select bool_and(has_function_privilege('authenticated', sig::regprocedure, 'EXECUTE')
                             and has_function_privilege('service_role', sig::regprocedure, 'EXECUTE')) from f),
         'вошедший и служебный ключ вызывают эти функции как раньше'
  union all
  -- Витрина для гостя: до 20261016 — две политики чтения на tenders и objects, после — представление
  -- public_open_tenders и ни одной политики для гостя на этих таблицах. Годится любое из двух состояний.
  select 4, (select count(*) from pg_policies where schemaname = 'public' and roles = '{anon}'
               and tablename in ('tenders', 'objects') and cmd = 'SELECT') = 2
            or (coalesce(has_table_privilege('anon', to_regclass('public.public_open_tenders'), 'select'), false)
                and not exists (select 1 from pg_policies where schemaname = 'public' and 'anon' = any (roles)
                                  and tablename in ('tenders', 'objects'))),
         'публичная витрина на месте: две политики чтения для анонима или представление public_open_tenders (после 20261016)'
  union all
  select 5, not exists (select 1 from pg_policies where schemaname = 'public' and 'anon' = any (roles)
                         and (coalesce(qual, '') || coalesce(with_check, '')) ~ '(is_admin|is_portal_employee|is_my_|current_counterparty_id|can_see_task|is_task_participant|is_negotiation_employee|vor_requests_can_access|osp_)'),
         'политики для анонима не вызывают функций-проверок'
)
select case when ok then 'OK ' else 'FAIL ' end || what from checks order by n;
