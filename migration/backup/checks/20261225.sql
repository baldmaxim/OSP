-- Проверка после 20261225_counterparty_number.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: колонка, счётчик и функция читаются через query_to_xml и to_regprocedure.
with
col as (
  select data_type, is_nullable, is_identity, identity_generation
  from information_schema.columns
  where table_schema = 'public' and table_name = 'counterparties' and column_name = 'counterparty_number'
),
nums as (
  select case when not exists (select 1 from col) then null
              else query_to_xml('select count(*) as total, count(distinct counterparty_number) as uniq,
                                        coalesce(min(counterparty_number), 1) as lo, coalesce(max(counterparty_number), 0) as hi
                                 from public.counterparties', false, true, '') end as x
),
seq as (
  select case when not exists (select 1 from col where is_identity = 'YES') then null
              else (xpath('/row/v/text()', query_to_xml(format(
                     'select case when is_called then last_value + 1 else last_value end as v from %s',
                     pg_get_serial_sequence('public.counterparties', 'counterparty_number')), false, true, '')))[1]::text::bigint
         end as next_value
),
v as (
  select (xpath('/row/total/text()', x))[1]::text::bigint as total,
         (xpath('/row/uniq/text()', x))[1]::text::bigint as uniq,
         (xpath('/row/lo/text()', x))[1]::text::bigint as lo,
         (xpath('/row/hi/text()', x))[1]::text::bigint as hi
  from nums
),
fn as (select to_regprocedure('public.counterparty_site_accounts()') as oid),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where data_type = 'integer' and is_nullable = 'NO'
                      and is_identity = 'YES' and identity_generation = 'ALWAYS'),
         'counterparties.counterparty_number: integer, NOT NULL, GENERATED ALWAYS AS IDENTITY'
  union all
  select 2, exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                    where i.indrelid = 'public.counterparties'::regclass and i.indisunique and i.indnatts = 1
                      and a.attname = 'counterparty_number'),
         'номер уникален (counterparties_number_key)'
  union all
  select 3, coalesce((select total = uniq and lo = 1 from v), false),
         'номер есть у каждого контрагента, без повторов, с 1'
  union all
  select 4, coalesce((select next_value from seq) > (select hi from v), false),
         'счётчик номеров — после наибольшего выданного'
  union all
  select 5, not exists (select 1 from pg_trigger where tgrelid = 'public.counterparties'::regclass
                          and tgname = 'trigger_update_counterparties_updated_at' and tgenabled <> 'O'),
         'триггер отметки времени снова включён'
  union all
  select 6, coalesce((select pg_get_function_result(oid) = 'TABLE(counterparty_id uuid, accounts integer)' from fn), false),
         'counterparty_site_accounts отдаёт только id организации и число'
  union all
  select 7, coalesce((select not has_function_privilege('anon', oid, 'execute') from fn), false),
         'гостю counterparty_site_accounts закрыта'
  union all
  select 8, (select relrowsecurity from pg_class where oid = 'public.counterparties'::regclass),
         'counterparties: RLS на месте'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
