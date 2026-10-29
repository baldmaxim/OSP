-- Проверка после 20261112_contracts_division.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: колонка читается через каталог, данные — query_to_xml и только если она есть.
with
col as (
  select column_name, data_type from information_schema.columns
  where table_schema = 'public' and table_name = 'contracts' and column_name = 'division'
),
-- Сколько договоров уже с подразделением (после миграции — 0, дальше растёт).
v as (
  select case when not exists (select 1 from col) then null
              else (xpath('/row/n/text()', query_to_xml(
                'select count(*) as n from public.contracts where division is not null', false, true, '')))[1]::text::bigint
         end as n
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where data_type = 'text'), 'contracts: division (text)'
  union all
  select 2, exists (select 1 from pg_constraint where conrelid = 'public.contracts'::regclass
                      and conname = 'contracts_division_check' and pg_get_constraintdef(oid) like '%finishing%'),
         'подразделение — только коды подразделений ВОР; указано у документов: ' || coalesce((select n from v)::text, '—')
  union all
  select 3, (select relrowsecurity from pg_class where oid = 'public.contracts'::regclass),
         'contracts: RLS на месте'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
