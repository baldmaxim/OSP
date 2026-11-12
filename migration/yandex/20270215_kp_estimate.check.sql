-- После 20270215_kp_estimate: смета КП / ПЗ объекта — таблицы, триггеры, служебные функции и права под одну учётку.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
tbl(t) as (values ('kp_estimates'), ('kp_estimate_rows'), ('kp_estimate_marks'), ('kp_estimate_allocations'), ('kp_estimate_log')),
pol as (
  select tablename, policyname, cmd, coalesce(qual, '') || coalesce(with_check, '') as body from pg_policies
  where schemaname = 'public' and tablename in (select t from tbl)
),
trg as (
  select c.relname, tg.tgname from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not tg.tgisinternal and c.relname in (select t from tbl)
),
checks(n, ok, what) as (
  select 1, (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace join tbl on tbl.t = c.relname
             where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity) = 5,
         'пять таблиц сметы, правила по строкам включены и действуют на владельца'
  union all
  select 2, (select count(*) from pol where policyname = 'osp_internal') = 5
            and (select count(*) from pol where policyname <> 'osp_internal' and body like '%role_in(%authenticated%') = 15
            and not exists (select 1 from pol where policyname <> 'osp_internal' and body not like '%osp_object_scope()%'),
         'пропуск служебных операций; у каждого правила — роль из токена и охват объектов вошедшего'
  union all
  select 3, (select count(*) from pol where cmd = 'SELECT' and body like '%kp_estimate_can(''view''%') = 5
            and (select count(*) from pol where cmd in ('INSERT', 'UPDATE', 'DELETE') and body like '%kp_estimate_can(''edit''%') = 10
            and not exists (select 1 from pol where tablename = 'kp_estimate_log' and cmd <> 'SELECT' and policyname <> 'osp_internal')
            and not exists (select 1 from pol where tablename = 'kp_estimate_rows' and cmd in ('UPDATE', 'DELETE')),
         'читает право «Объекты» или «Смета КП/ПЗ», пишет право правки сметы; журнал — только чтение, строки — только вставка'
  union all
  select 4, exists (select 1 from pol where tablename = 'kp_estimates' and cmd = 'DELETE' and body like '%is_admin()%' and body like '%draft%'),
         'действующую и прежнюю смету удаляет только администратор, черновик — право правки'
  union all
  select 5, (select count(*) from osp_meta.policy_roles pr join tbl on tbl.t = pr.table_name
             where pr.schema_name = 'public' and pr.roles = array['authenticated']) = 15,
         'записи о ролях всех правил'
  union all
  select 6, (select count(*) from trg where tgname in ('kp_estimates_touch', 'kp_estimates_log_cleanup', 'kp_estimate_rows_touch',
               'kp_estimate_marks_touch', 'kp_estimate_allocations_touch', 'kp_estimate_marks_log', 'kp_estimate_allocations_log')) = 7,
         'триггеры: черновик, кто и когда, только действующая смета, история'
  union all
  select 7, (select bool_and(prosecdef and proconfig @> array['application_name=osp:internal']) from pg_proc
             where pronamespace = 'public'::regnamespace and proname in ('kp_estimate_can', 'kp_estimate_actor_name', 'kp_estimate_log_write',
               'kp_estimates_log_cleanup', 'kp_estimate_row_map', 'kp_estimate_activate'))
            and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('kp_estimate_can', 'kp_estimate_actor_name',
               'kp_estimate_log_write', 'kp_estimates_log_cleanup', 'kp_estimate_row_map', 'kp_estimate_activate')) = 6
            and (select bool_and(not prosecdef) from pg_proc where pronamespace = 'public'::regnamespace
                   and proname in ('kp_estimates_touch', 'kp_estimate_rows_touch', 'kp_estimate_item_touch', 'kp_estimate_transfer_on')),
         'служебные функции — с отметкой пропуска; триггеры «кто и когда» — с правами вызывающего'
  union all
  select 8, exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'kp_estimates_one_active' and indexdef like '%WHERE%active%')
            and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'kp_estimate_allocations_pair' and indexdef like '%UNIQUE%'),
         'одна действующая смета на объект; пара «тендер + подрядчик» у позиции одна'
  union all
  select 9, not exists (select 1 from public.roles where key = 'economist')
            or exists (select 1 from public.role_permissions where role = 'economist' and section = 'kp_estimate' and can_view and can_edit),
         'экономист ОСП: право работать со сметой'
)
select case when ok is true then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
