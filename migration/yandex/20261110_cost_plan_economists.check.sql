-- После 20261110_cost_plan_economists: экономисты ОСП по объектам — таблица, триггер и права под одну учётку.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
-- Начальное назначение не проверяется на FAIL: нет объекта или сотрудника в этой базе — строку назначит
-- администратор, откатывать из-за этого всю миграцию незачем (число назначенных — в тексте строки 6).
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename = 'cost_plan_economists'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity and c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'cost_plan_economists' and c.relkind = 'r'), false),
         'экономисты ОСП по объектам: таблица есть, правила по строкам включены и действуют на владельца'
  union all
  select 2, exists (select 1 from pol where policyname = 'osp_internal')
            and (select count(*) from pol where policyname <> 'osp_internal' and qual || chk like '%role_in(%authenticated%') = 4
            and exists (select 1 from pol where cmd = 'SELECT' and policyname <> 'osp_internal' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where cmd in ('INSERT', 'UPDATE', 'DELETE') and policyname <> 'osp_internal'
                   and qual || chk like '%is_admin()%') = 3,
         'пропуск служебных операций; читает сотрудник, назначает только администратор'
  union all
  select 3, (select count(*) from osp_meta.policy_roles where schema_name = 'public' and table_name = 'cost_plan_economists'
             and roles = array['authenticated']) = 4,
         'записи о ролях четырёх политик'
  union all
  select 4, exists (select 1 from pg_trigger tg where tg.tgrelid = 'public.cost_plan_economists'::regclass
                      and tg.tgname = 'cost_plan_economists_touch' and not tg.tgisinternal),
         'триггер «кто изменил» на месте'
  union all
  select 5, (select count(*) from pg_constraint where conrelid = 'public.cost_plan_economists'::regclass and contype = 'f'
               and confdeltype = 'c' and confrelid in ('public.objects'::regclass, 'public.contacts'::regclass)) = 2
            and exists (select 1 from pg_constraint where conrelid = 'public.cost_plan_economists'::regclass
                          and conname = 'cost_plan_economists_object_key' and contype = 'u'),
         'один экономист на объект; удаление объекта или сотрудника удаляет назначение'
  union all
  select 6, true,
         'начальное назначение: объектов с экономистом — ' || (select count(*) from public.cost_plan_economists)
         || ' (по решению 27.10 — 9; меньше — недостающих назначит администратор)'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
