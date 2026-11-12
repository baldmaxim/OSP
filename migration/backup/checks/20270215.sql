-- Проверка после 20270215_kp_estimate.sql (смета КП / ПЗ объекта). Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: объекты ищутся через to_regclass.
with
tbl(t) as (values ('kp_estimates'), ('kp_estimate_rows'), ('kp_estimate_marks'), ('kp_estimate_allocations'), ('kp_estimate_log')),
pol as (
  select tablename, policyname, cmd, roles, coalesce(qual, '') || coalesce(with_check, '') as body from pg_policies
  where schemaname = 'public' and tablename in (select t from tbl)
),
trg as (
  select c.relname, tg.tgname from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not tg.tgisinternal and c.relname in (select t from tbl)
),
checks(n, ok, what) as (
  select 1, (select count(*) from tbl where coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || tbl.t)), false)) = 5,
         'смета КП / ПЗ: пять таблиц, RLS включён'
  union all
  select 2, (select count(*) from pol where roles = '{authenticated}') = 15
            and (select count(*) from pol where cmd = 'SELECT' and body like '%kp_estimate_can(''view''%' and body like '%kp_estimate_in_scope(object_id)%') = 5
            and (select count(*) from pol where cmd in ('INSERT', 'UPDATE', 'DELETE') and body like '%kp_estimate_can(''edit''%'
                   and body like '%kp_estimate_in_scope(object_id)%') = 10,
         'читает право «Объекты» или «Смета КП/ПЗ», пишет право правки сметы, по объектам своего охвата'
  union all
  select 3, coalesce((select bool_and(not has_table_privilege('anon', to_regclass('public.' || t), 'select')) from tbl), false)
            and coalesce(not has_table_privilege('authenticated', to_regclass('public.kp_estimate_log'), 'insert'), false)
            and coalesce(not has_table_privilege('authenticated', to_regclass('public.kp_estimate_rows'), 'update'), false),
         'гостю ничего; журнал и строки сметы вошедшим не переписать'
  union all
  select 4, (select count(*) from trg where tgname in ('kp_estimates_touch', 'kp_estimates_log_cleanup', 'kp_estimate_rows_touch',
               'kp_estimate_marks_touch', 'kp_estimate_allocations_touch', 'kp_estimate_marks_log', 'kp_estimate_allocations_log')) = 7,
         'триггеры: черновик, кто и когда, только действующая смета, история'
  union all
  select 5, coalesce((select has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
                      from pg_proc p where p.oid = to_regprocedure('public.kp_estimate_activate(uuid)')), false),
         'загрузку версии вызывает вошедший, гость — нет'
  union all
  select 6, not exists (select 1 from public.roles where key = 'economist')
            or exists (select 1 from public.role_permissions where role = 'economist' and section = 'kp_estimate' and can_view and can_edit),
         'экономист ОСП: право работать со сметой'
)
select case when ok is true then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
