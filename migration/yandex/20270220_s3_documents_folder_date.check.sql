-- После 20270220_s3_documents_folder_date: у файла — день папки, куда его положили явно; данные не тронуты.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
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
  select 3, not exists (select 1 from public.s3_documents where folder_date is not null),
         's3_documents: дней папок ещё нет — данные не изменились'
  union all
  select 4, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.s3_documents'::regclass),
         's3_documents: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
