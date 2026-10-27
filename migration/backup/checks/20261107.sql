-- Проверка после 20261107_section_templates.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: объекты ищутся через to_regclass.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, roles from pg_policies
  where schemaname = 'public' and tablename = 'section_templates'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.section_templates')), false),
         'шаблоны разделов: таблица создана, RLS включён'
  union all
  select 2, (select count(*) from pol) = 1
            and exists (select 1 from pol where cmd = 'SELECT' and roles = '{authenticated}' and qual like '%osp_is_employee()%'),
         'читает сотрудник; правил записи нет'
  union all
  select 3, coalesce(not has_table_privilege('anon', to_regclass('public.section_templates'), 'select')
                     and has_table_privilege('authenticated', to_regclass('public.section_templates'), 'select')
                     and not has_table_privilege('authenticated', to_regclass('public.section_templates'), 'insert')
                     and not has_table_privilege('authenticated', to_regclass('public.section_templates'), 'update')
                     and not has_table_privilege('authenticated', to_regclass('public.section_templates'), 'delete'), false),
         'гостю ничего не выдано, вошедшему — только чтение'
  union all
  -- Таблица читается, только если она есть (query_to_xml): прямое обращение до миграции — ошибка разбора.
  select 4, case when to_regclass('public.section_templates') is null then false
                 else (xpath('/row/n/text()', query_to_xml(
                   'select count(*) as n from public.section_templates where code in (''tenders_concept_agreement'', ''dc_was_became'')',
                   false, true, '')))[1]::text::int = 2 end,
         'шаблоны «Понятийное соглашение» и «Шаблон Было-Стало» заведены'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
