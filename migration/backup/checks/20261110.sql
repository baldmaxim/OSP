-- Проверка после 20261110_cost_plan_economists.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: объекты ищутся через to_regclass.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk, roles from pg_policies
  where schemaname = 'public' and tablename = 'cost_plan_economists'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.cost_plan_economists')), false),
         'экономисты ОСП по объектам: таблица создана, RLS включён'
  union all
  select 2, (select count(*) from pol where roles = '{authenticated}') = 4
            and exists (select 1 from pol where cmd = 'SELECT' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where cmd in ('INSERT', 'UPDATE', 'DELETE') and qual || chk like '%is_admin()%') = 3,
         'читает сотрудник; назначает только администратор'
  union all
  select 3, coalesce(not has_table_privilege('anon', to_regclass('public.cost_plan_economists'), 'select'), false),
         'гостю ничего не выдано'
  union all
  select 4, exists (select 1 from pg_trigger tg where tg.tgrelid = to_regclass('public.cost_plan_economists')
                      and tg.tgname = 'cost_plan_economists_touch' and not tg.tgisinternal),
         'триггер «кто изменил» на месте'
  union all
  select 5, (select count(*) from pg_constraint where conrelid = to_regclass('public.cost_plan_economists') and contype = 'f'
               and confdeltype = 'c' and confrelid in (to_regclass('public.objects'), to_regclass('public.contacts'))) = 2
            and exists (select 1 from pg_constraint where conrelid = to_regclass('public.cost_plan_economists')
                          and conname = 'cost_plan_economists_object_key'),
         'один экономист на объект; удаление объекта или сотрудника удаляет назначение'
  union all
  -- Начальное назначение зависит от данных (объекты и сотрудники справочника), поэтому не FAIL, а число в тексте:
  -- на проде сразу после миграции — 9 (решение 27.10); меньше — в базе нет какого-то объекта или сотрудника, их
  -- назначит администратор. Таблица читается, только если она есть (query_to_xml): прямое обращение до миграции —
  -- ошибка разбора.
  select 6, to_regclass('public.cost_plan_economists') is not null,
         'начальное назначение: объектов с экономистом ОСП — '
         || case when to_regclass('public.cost_plan_economists') is null then 'таблицы нет'
                 else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.cost_plan_economists',
                   false, true, '')))[1]::text end
         || ' (на проде должно быть 9)'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
