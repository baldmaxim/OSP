-- После 20270308_kp_estimate_prices: цены сметы КП / ПЗ, изменённые администратором. Строки «OK …» / «FAIL …»; выполняется в
-- транзакции миграции (migrate.sh), с отметкой служебной операции.
with
tbl(t) as (values ('kp_estimate_prices'), ('kp_estimate_price_docs')),
pol as (
  select tablename, policyname, cmd, coalesce(qual, '') || coalesce(with_check, '') as body from pg_policies
  where schemaname = 'public' and tablename in (select t from tbl)
),
fn as (
  select p.proname, p.prosecdef, p.proconfig, pg_get_functiondef(p.oid) as body from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname in ('kp_estimate_price_apply', 'kp_estimate_price_reset', 'kp_estimate_activate')
),
checks(n, ok, what) as (
  select 1, (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace join tbl on tbl.t = c.relname
             where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity) = 2,
         'две таблицы цен, правила по строкам включены и действуют на владельца'
  union all
  select 2, (select count(*) from pol where policyname = 'osp_internal') = 2
            and (select count(*) from pol where policyname <> 'osp_internal') = 2
            and not exists (select 1 from pol where policyname <> 'osp_internal' and cmd <> 'SELECT')
            and not exists (select 1 from pol where policyname <> 'osp_internal'
                              and (body not like '%kp_estimate_can(''view''%' or body not like '%osp_object_scope()%' or body not like '%role_in(%authenticated%')),
         'читают как смету (право и охват объектов), записи у вошедшего нет — только служебными функциями'
  union all
  select 3, (select count(*) from osp_meta.policy_roles pr join tbl on tbl.t = pr.table_name
             where pr.schema_name = 'public' and pr.policy_name = pr.table_name || '_read' and pr.roles = array['authenticated']) = 2,
         'записи о ролях правил чтения'
  union all
  select 4, (select count(*) from fn where proname in ('kp_estimate_price_apply', 'kp_estimate_price_reset')
               and prosecdef and proconfig @> array['application_name=osp:internal']
               and body like '%is_admin()%' and body like '%psdc_object_in_scope%' and body like '%kp_estimate_log%') = 2,
         'цены пишет только администратор по объекту своего охвата, каждая правка — в историю'
  union all
  select 5, exists (select 1 from fn where proname = 'kp_estimate_activate' and prosecdef
                      and body like '%kp_estimate_prices p SET row_id%' and body like '%kp_estimate_price_docs SET estimate_id%'),
         'новая версия файла переносит цены и документы цен'
  union all
  select 6, exists (select 1 from pg_constraint where conrelid = 'public.kp_estimate_log'::regclass
                      and conname = 'kp_estimate_log_entity_check' and pg_get_constraintdef(oid) like '%price%'),
         'история принимает правки цен'
  union all
  select 7, exists (select 1 from pg_constraint where conrelid = 'public.kp_estimate_prices'::regclass and contype = 'u'
                      and pg_get_constraintdef(oid) like '%row_id%'),
         'одна цена на строку'
)
select case when ok is true then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
