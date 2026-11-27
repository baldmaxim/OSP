-- Проверка после 20270308_kp_estimate_prices.sql (цены сметы КП / ПЗ, изменённые администратором). Каждая строка — «OK …»
-- или «FAIL …». Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: объекты ищутся через to_regclass / to_regprocedure.
with
tbl(t) as (values ('kp_estimate_prices'), ('kp_estimate_price_docs')),
pol as (
  select tablename, policyname, cmd, roles, coalesce(qual, '') || coalesce(with_check, '') as body from pg_policies
  where schemaname = 'public' and tablename in (select t from tbl)
),
fn as (
  select p.oid, p.proname, p.prosecdef, pg_get_functiondef(p.oid) as body from pg_proc p
  where p.oid in (to_regprocedure('public.kp_estimate_price_apply(uuid, jsonb, jsonb)'), to_regprocedure('public.kp_estimate_price_reset(uuid, uuid[])'))
),
checks(n, ok, what) as (
  select 1, (select count(*) from tbl where coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || tbl.t)), false)) = 2,
         'цены сметы: две таблицы, RLS включён'
  union all
  select 2, (select count(*) from pol) = 2
            and (select count(*) from pol where cmd = 'SELECT' and roles = '{authenticated}' and body like '%kp_estimate_can(''view''%'
                   and body like '%kp_estimate_in_scope(object_id)%') = 2,
         'читают как смету: право «Объекты» или «Смета КП/ПЗ», объекты своего охвата; правил записи нет'
  union all
  select 3, coalesce((select bool_and(not has_table_privilege('anon', to_regclass('public.' || t), 'select')
                                      and not has_table_privilege('authenticated', to_regclass('public.' || t), 'insert')
                                      and not has_table_privilege('authenticated', to_regclass('public.' || t), 'update')
                                      and not has_table_privilege('authenticated', to_regclass('public.' || t), 'delete')) from tbl), false),
         'гостю ничего, вошедшему — только чтение'
  union all
  select 4, (select count(*) from fn where prosecdef and body like '%is_admin()%' and body like '%psdc_object_in_scope%'
               and has_function_privilege('authenticated', oid, 'execute') and not has_function_privilege('anon', oid, 'execute')) = 2,
         'цены пишут две служебные функции — только администратор по объекту своего охвата; гость не вызывает'
  union all
  select 5, coalesce((select pg_get_functiondef(p.oid) like '%kp_estimate_prices p SET row_id%' from pg_proc p
                      where p.oid = to_regprocedure('public.kp_estimate_activate(uuid)')), false),
         'новая версия файла переносит цены'
  union all
  select 6, exists (select 1 from pg_constraint where conrelid = to_regclass('public.kp_estimate_log')
                      and conname = 'kp_estimate_log_entity_check' and pg_get_constraintdef(oid) like '%price%'),
         'история принимает правки цен'
)
select case when ok is true then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
