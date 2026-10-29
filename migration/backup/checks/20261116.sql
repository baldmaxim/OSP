-- Проверка после 20261116_cost_plan_calc.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: объекты ищутся через to_regclass, таблицы читаются через query_to_xml.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk, roles from pg_policies
  where schemaname = 'public' and tablename = 'cost_plan_compensation'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.cost_plan_compensation')), false),
         'компенсация НДС и инфляции по объектам: таблица создана, RLS включён'
  union all
  select 2, (select count(*) from pol where roles = '{authenticated}') = 4
            and exists (select 1 from pol where cmd = 'SELECT' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where cmd in ('INSERT', 'UPDATE', 'DELETE') and qual || chk like '%is_admin()%') = 3,
         'читает сотрудник; вносит и меняет только администратор'
  union all
  select 3, coalesce(not has_table_privilege('anon', to_regclass('public.cost_plan_compensation'), 'select'), false),
         'гостю ничего не выдано'
  union all
  select 4, exists (select 1 from pg_trigger tg where tg.tgrelid = to_regclass('public.cost_plan_compensation')
                      and tg.tgname = 'cost_plan_compensation_touch' and not tg.tgisinternal),
         'триггер «кто изменил» на месте'
  union all
  select 5, exists (select 1 from pg_constraint where conrelid = to_regclass('public.cost_plan_compensation') and contype = 'f'
                      and confdeltype = 'c' and confrelid = to_regclass('public.objects'))
            and exists (select 1 from pg_constraint where conrelid = to_regclass('public.cost_plan_compensation')
                          and conname = 'cost_plan_compensation_object_key'),
         'одна строка на объект; удаление объекта удаляет сведения'
  union all
  select 6, to_regclass('public.section_templates') is not null
            and (xpath('/row/n/text()', query_to_xml(
                  'select count(*) as n from public.section_templates where code in (''cost_plan_direct_costs'', ''cost_plan_kp_before_transfers'')',
                  false, true, '')))[1]::text = '2',
         'якоря файлов «Расчёта ПЗ»: «Прямые затраты» и «КП до перекидок» (нужна 20261107_section_templates)'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
