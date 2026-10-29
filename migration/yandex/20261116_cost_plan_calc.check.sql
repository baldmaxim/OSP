-- После 20261116_cost_plan_calc: компенсация НДС и инфляции по объектам — таблица, триггер и права под одну учётку;
-- якоря файлов «Расчёта ПЗ» в section_templates. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции
-- (migrate.sh), с отметкой служебной операции.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename = 'cost_plan_compensation'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity and c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'cost_plan_compensation' and c.relkind = 'r'), false),
         'компенсация НДС и инфляции по объектам: таблица есть, правила по строкам включены и действуют на владельца'
  union all
  select 2, exists (select 1 from pol where policyname = 'osp_internal')
            and (select count(*) from pol where policyname <> 'osp_internal' and qual || chk like '%role_in(%authenticated%') = 4
            and exists (select 1 from pol where cmd = 'SELECT' and policyname <> 'osp_internal' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where cmd in ('INSERT', 'UPDATE', 'DELETE') and policyname <> 'osp_internal'
                   and qual || chk like '%is_admin()%') = 3,
         'пропуск служебных операций; читает сотрудник, вносит и меняет только администратор'
  union all
  select 3, (select count(*) from osp_meta.policy_roles where schema_name = 'public' and table_name = 'cost_plan_compensation'
             and roles = array['authenticated']) = 4,
         'записи о ролях четырёх политик'
  union all
  select 4, exists (select 1 from pg_trigger tg where tg.tgrelid = 'public.cost_plan_compensation'::regclass
                      and tg.tgname = 'cost_plan_compensation_touch' and not tg.tgisinternal),
         'триггер «кто изменил» на месте'
  union all
  select 5, exists (select 1 from pg_constraint where conrelid = 'public.cost_plan_compensation'::regclass and contype = 'f'
                      and confdeltype = 'c' and confrelid = 'public.objects'::regclass)
            and exists (select 1 from pg_constraint where conrelid = 'public.cost_plan_compensation'::regclass
                          and conname = 'cost_plan_compensation_object_key' and contype = 'u'),
         'одна строка на объект; удаление объекта удаляет сведения'
  union all
  -- Таблица шаблонов приходит с 20261107; без неё якорей нет — это не повод откатывать компенсацию.
  select 6, to_regclass('public.section_templates') is null
            or (xpath('/row/n/text()', query_to_xml(
                  'select count(*) as n from public.section_templates where code in (''cost_plan_direct_costs'', ''cost_plan_kp_before_transfers'')',
                  false, true, '')))[1]::text = '2',
         'якоря файлов «Расчёта ПЗ»: «Прямые затраты» и «КП до перекидок»'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
