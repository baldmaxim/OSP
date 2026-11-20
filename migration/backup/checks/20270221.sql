-- Проверка после 20270221_doc_check_tender_link.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции; до миграции отвечает FAIL, а не падает.
with
col as (
  select data_type, is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 'doc_check_requests' and column_name = 'tender_id'
),
fk as (
  select pg_get_constraintdef(oid) as def from pg_constraint
  where conrelid = 'public.doc_check_requests'::regclass and conname = 'doc_check_requests_tender_id_fkey' and contype = 'f'
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
  select 4, exists (select 1 from pg_trigger where tgrelid = 'public.doc_check_requests'::regclass
                      and tgname = 'doc_check_requests_tender_history' and not tgisinternal),
         'смена тендера пишется в историю заявки'
  union all
  select 5, (select relrowsecurity from pg_class where oid = 'public.doc_check_requests'::regclass),
         'doc_check_requests: RLS по-прежнему включён'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
