-- Проверка после 20261104_company_departments.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: объекты ищутся через to_regclass.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk, roles from pg_policies
  where schemaname = 'public' and tablename = 'company_departments'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.company_departments')), false),
         'отделы: таблица создана, RLS включён'
  union all
  select 2, (select count(*) from pol where roles = '{authenticated}') = 4
            and exists (select 1 from pol where cmd = 'SELECT' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where cmd in ('INSERT', 'UPDATE', 'DELETE') and qual || chk like '%is_admin()%') = 3,
         'читает сотрудник; правит только администратор'
  union all
  select 3, coalesce(not has_table_privilege('anon', to_regclass('public.company_departments'), 'select'), false),
         'гостю ничего не выдано'
  union all
  select 4, exists (select 1 from pg_trigger tg where tg.tgrelid = to_regclass('public.company_departments')
                      and tg.tgname = 'company_departments_touch' and not tg.tgisinternal),
         'триггер «очистка и кто изменил» на месте'
  union all
  -- Таблица читается, только если она есть (query_to_xml): прямое обращение до миграции — ошибка разбора.
  select 5, case when to_regclass('public.company_departments') is null then false
                 else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.company_departments',
                   false, true, '')))[1]::text::int >= 26 end,
         'начальный список отделов заведён'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
