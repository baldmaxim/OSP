-- Проверка после 20261119_work_types_division_other.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: колонка читается через каталог, данные — query_to_xml и только если она есть.
with
col as (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'work_types' and column_name = 'division'
),
v as (
  select case when not exists (select 1 from col) then null
              else (xpath('/row/n/text()', query_to_xml(
                'select count(*) as n from public.work_types where division is null', false, true, '')))[1]::text::bigint
         end as nulls,
         case when not exists (select 1 from col) then null
              else (xpath('/row/n/text()', query_to_xml(
                'select count(*) as n from public.work_types where division = ''other''', false, true, '')))[1]::text::bigint
         end as other
),
checks(n, ok, what) as (
  select 1, exists (select 1 from pg_constraint where conrelid = 'public.work_types'::regclass
                      and conname = 'work_types_division_check'
                      and pg_get_constraintdef(oid) like '%finishing%' and pg_get_constraintdef(oid) like '%''other''%'),
         'подразделение — коды подразделений ВОР и «Прочее» (other); «Прочее»: ' || coalesce((select other from v)::text, '—')
  union all
  select 2, coalesce((select nulls from v) = 0, false),
         'видов работ без подразделения: ' || coalesce((select nulls from v)::text, '— (нет колонки division)')
  union all
  select 3, (select relrowsecurity from pg_class where oid = 'public.work_types'::regclass),
         'work_types: RLS на месте'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
