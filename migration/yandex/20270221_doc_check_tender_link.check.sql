-- После 20270221_doc_check_tender_link: у заявки доски ДП/ДС — необязательная ссылка на тендер, смена — в историю; данные не тронуты.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
col as (
  select data_type, is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 'doc_check_requests' and column_name = 'tender_id'
),
fk as (
  select pg_get_constraintdef(oid) as def from pg_constraint
  where conrelid = 'public.doc_check_requests'::regclass and conname = 'doc_check_requests_tender_id_fkey' and contype = 'f'
),
fn as (
  select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg from pg_proc p
  where p.oid = to_regprocedure('public.doc_check_requests_tender_history()')
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where data_type = 'uuid' and is_nullable = 'YES'),
         'doc_check_requests.tender_id: uuid, может быть пустым'
  union all
  select 2, coalesce((select def like '%REFERENCES tenders(id)%' and def like '%ON DELETE SET NULL%' from fk), false),
         'ссылка — на тендер, при его удалении пустеет (ON DELETE SET NULL)'
  union all
  select 3, exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'doc_check_requests'
                      and indexname = 'idx_doc_check_requests_tender_id'),
         'индекс по ссылке на тендер'
  union all
  select 4, coalesce((select prosecdef and cfg like '%application_name=osp:internal%' from fn), false),
         'история смены тендера: служебная функция с отметкой osp:internal'
  union all
  select 5, exists (select 1 from pg_trigger where tgrelid = 'public.doc_check_requests'::regclass
                      and tgname = 'doc_check_requests_tender_history' and not tgisinternal and tgenabled = 'O'),
         'триггер истории смены тендера включён'
  union all
  select 6, to_regprocedure('public.doc_check_history_write(uuid, text, text, jsonb, jsonb, text)') is not null,
         'запись истории заявки (20270216) на месте'
  union all
  select 7, not exists (select 1 from public.doc_check_requests where tender_id is not null),
         'doc_check_requests: ссылок ещё нет — данные не изменились'
  union all
  select 8, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.doc_check_requests'::regclass),
         'doc_check_requests: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
