-- Проверка после 20261109_contracts_dc_requests.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: колонки читаются через каталог, данные — query_to_xml и только если колонка есть.
with
col as (
  select column_name, data_type from information_schema.columns
  where table_schema = 'public' and table_name = 'dc_requests' and column_name in ('contract_id', 'amendment_id', 'division')
),
fk as (
  select a.attname, c.confdeltype from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
  where c.conrelid = 'public.dc_requests'::regclass and c.contype = 'f' and c.confrelid = 'public.contracts'::regclass
    and array_length(c.conkey, 1) = 1
),
-- Заявки, у которых договор — не договор (ДП); сколько заявок получили договор.
v as (
  select case when not exists (select 1 from col where column_name = 'contract_id') then null
              else (xpath('/row/bad/text()', query_to_xml(
                'select count(*) filter (where c.record_type <> ''dp'') as bad
                 from public.dc_requests r join public.contracts c on c.id = r.contract_id', false, true, '')))[1]::text::bigint
         end as bad,
         case when not exists (select 1 from col where column_name = 'contract_id') then null
              else (xpath('/row/linked/text()', query_to_xml(
                'select count(*) as linked from public.dc_requests where contract_id is not null', false, true, '')))[1]::text::bigint
         end as linked
),
tpl as (
  select case when to_regclass('public.section_templates') is null then null
              else (xpath('/row/n/text()', query_to_xml(
                'select count(*) as n from public.section_templates where code = ''contracts_dgp''', false, true, '')))[1]::text::bigint
         end as n
),
checks(n, ok, what) as (
  select 1, (select count(*) from col where (column_name in ('contract_id', 'amendment_id') and data_type = 'uuid')
                                         or (column_name = 'division' and data_type = 'text')) = 3,
         'dc_requests: contract_id, amendment_id (uuid), division (text)'
  union all
  select 2, exists (select 1 from fk where attname = 'contract_id' and confdeltype = 'n')
            and exists (select 1 from fk where attname = 'amendment_id' and confdeltype = 'n'),
         'contract_id и amendment_id ссылаются на contracts, при удалении договора — пусто'
  union all
  select 3, exists (select 1 from pg_constraint where conrelid = 'public.dc_requests'::regclass
                      and conname = 'dc_requests_division_check' and pg_get_constraintdef(oid) like '%finishing%'),
         'подразделение — только коды подразделений ВОР'
  union all
  select 4, to_regclass('public.idx_dc_requests_contract') is not null and to_regclass('public.idx_dc_requests_amendment') is not null,
         'индексы по договору и ДС заявки'
  union all
  select 5, coalesce((select bad from v) = 0, false),
         'договор заявки — договор (ДП), а не ДС; договор подставлен заявкам: '
           || coalesce((select linked from v)::text, '—')
  union all
  select 6, coalesce((select n from tpl) = 1, false),
         '«Шаблон ДГП» заведён (нужна 20261107_section_templates)'
  union all
  select 7, (select relrowsecurity from pg_class where oid = 'public.dc_requests'::regclass),
         'dc_requests: RLS на месте'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
