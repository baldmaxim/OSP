-- Проверка после 20270220_s3_documents_folder_date.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции; до миграции отвечает FAIL, а не падает.
with
col as (
  select data_type, is_nullable, column_default from information_schema.columns
  where table_schema = 'public' and table_name = 's3_documents' and column_name = 'folder_date'
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where data_type = 'date' and is_nullable = 'YES' and column_default is null),
         's3_documents.folder_date: date, может быть пустым, без значения по умолчанию'
  union all
  select 2, exists (select 1 from pg_constraint where conrelid = 'public.s3_documents'::regclass
                      and conname = 's3_documents_folder_date_sane' and contype = 'c'),
         'день папки — не раньше 2000 года'
  union all
  select 3, (select relrowsecurity from pg_class where oid = 'public.s3_documents'::regclass),
         's3_documents: RLS по-прежнему включён'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
