-- Проверка после 20261106_dc_request_number.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: колонка и счётчик читаются через query_to_xml и только если они есть.
with
col as (
  select data_type, is_nullable, is_identity, identity_generation
  from information_schema.columns
  where table_schema = 'public' and table_name = 'dc_requests' and column_name = 'request_number'
),
-- Числа по заявкам: всего, разных номеров, наименьший, наибольший; следующий номер счётчика.
nums as (
  select case when not exists (select 1 from col) then null
              else query_to_xml('select count(*) as total, count(distinct request_number) as uniq,
                                        coalesce(min(request_number), 1) as lo, coalesce(max(request_number), 0) as hi
                                 from public.dc_requests', false, true, '') end as x
),
seq as (
  select case when not exists (select 1 from col where is_identity = 'YES') then null
              else (xpath('/row/v/text()', query_to_xml(format(
                     'select case when is_called then last_value + 1 else last_value end as v from %s',
                     pg_get_serial_sequence('public.dc_requests', 'request_number')), false, true, '')))[1]::text::bigint
         end as next_value
),
v as (
  select (xpath('/row/total/text()', x))[1]::text::bigint as total,
         (xpath('/row/uniq/text()', x))[1]::text::bigint as uniq,
         (xpath('/row/lo/text()', x))[1]::text::bigint as lo,
         (xpath('/row/hi/text()', x))[1]::text::bigint as hi
  from nums
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where data_type = 'integer' and is_nullable = 'NO'
                      and is_identity = 'YES' and identity_generation = 'ALWAYS'),
         'dc_requests.request_number: integer, NOT NULL, GENERATED ALWAYS AS IDENTITY'
  union all
  select 2, exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                    where i.indrelid = 'public.dc_requests'::regclass and i.indisunique and i.indnatts = 1
                      and a.attname = 'request_number'),
         'dc_requests.request_number уникален (dc_requests_request_number_key)'
  union all
  select 3, coalesce((select total = uniq and lo = 1 from v), false),
         'номер есть у каждой заявки, без повторов, с 1'
  union all
  select 4, coalesce((select next_value from seq) > (select hi from v), false),
         'счётчик номеров — после наибольшего выданного'
  union all
  select 5, (select relrowsecurity from pg_class where oid = 'public.dc_requests'::regclass),
         'dc_requests: RLS на месте'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
