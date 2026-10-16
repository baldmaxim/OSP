-- После 20261011: у s3_documents есть sha256 с проверкой формата, прежние строки не тронуты.
-- Строки «OK …» / «FAIL …»; только чтение. До миграции отвечает FAIL, а не падает (restore-copy.sh решает по ней,
-- применена ли миграция в копии): обращение к колонке — только если она есть (query_to_xml).
with
col as (
  select data_type, is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 's3_documents' and column_name = 'sha256'
),
con as (
  select pg_get_constraintdef(c.oid) def from pg_constraint c
  where c.conrelid = 'public.s3_documents'::regclass and c.conname = 's3_documents_sha256_hex'
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where data_type = 'text' and is_nullable = 'YES'),
         's3_documents.sha256: text, допускает NULL'
  union all
  select 2, exists (select 1 from con where def like '%[0-9a-f]{64}%'),
         's3_documents.sha256: проверка «64 шестнадцатеричных символа»'
  union all
  select 3, case when not exists (select 1 from col) then false
                 else (xpath('/row/n/text()', query_to_xml(
                   'select count(*) as n from public.s3_documents where sha256 is not null and sha256 !~ ''^[0-9a-f]{64}$''',
                   false, true, '')))[1]::text = '0' end,
         's3_documents.sha256: неверных значений нет'
  union all
  select 4, (select relrowsecurity from pg_class where oid = 'public.s3_documents'::regclass),
         's3_documents: RLS по-прежнему включён'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
