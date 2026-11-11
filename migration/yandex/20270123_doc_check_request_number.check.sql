-- После 20270123_doc_check_request_number: у каждой заявки на проверку ДП/ДС постоянный номер — doc_check_requests.request_number (integer,
-- NOT NULL, GENERATED ALWAYS AS IDENTITY, уникальный), счётчик — после наибольшего номера; правила по строкам на месте.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
col as (
  select data_type, is_nullable, is_identity, identity_generation
  from information_schema.columns
  where table_schema = 'public' and table_name = 'doc_check_requests' and column_name = 'request_number'
),
-- Следующий номер счётчика: last_value, а если счётчик ещё не выдавал номер после setval — он сам.
seq as (
  select (xpath('/row/v/text()', query_to_xml(format(
           'select case when is_called then last_value + 1 else last_value end as v from %s',
           pg_get_serial_sequence('public.doc_check_requests', 'request_number')), false, true, '')))[1]::text::bigint as next_value
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where data_type = 'integer' and is_nullable = 'NO'
                      and is_identity = 'YES' and identity_generation = 'ALWAYS'),
         'doc_check_requests.request_number: integer, NOT NULL, GENERATED ALWAYS AS IDENTITY'
  union all
  select 2, exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                    where i.indrelid = 'public.doc_check_requests'::regclass and i.indisunique and i.indnatts = 1
                      and a.attname = 'request_number'),
         'doc_check_requests.request_number уникален (doc_check_requests_request_number_key)'
  union all
  select 3, (select count(*) from public.doc_check_requests) = (select count(distinct request_number) from public.doc_check_requests)
            and coalesce((select min(request_number) from public.doc_check_requests), 1) = 1,
         'номер есть у каждой заявки, без повторов, с 1'
  union all
  select 4, coalesce((select next_value from seq) > coalesce((select max(request_number) from public.doc_check_requests), 0), false),
         'счётчик номеров — после наибольшего выданного'
  union all
  select 5, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.doc_check_requests'::regclass),
         'doc_check_requests: RLS включён и действует на владельца'
  union all
  select 6, (select tgenabled = 'O' from pg_trigger
             where tgrelid = 'public.doc_check_requests'::regclass and tgname = 'trg_doc_check_requests_updated_at'),
         'триггер updated_at заявок снова включён'
  union all
  select 7, not exists (select 1 from public.doc_check_requests where updated_at >= now()),
         'нумерация не сдвинула updated_at ни одной заявки'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
