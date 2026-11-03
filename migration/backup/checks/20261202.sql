-- Проверка после 20261202_object_documents_md.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: всё читается через каталог.
with
checks(n, ok, what) as (
  select 1, exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'object_documents'
                      and column_name = 'md_s3_document_id' and data_type = 'uuid'),
         'object_documents: md_s3_document_id (uuid)'
  union all
  select 2, exists (select 1 from pg_constraint
                    where conrelid = 'public.object_documents'::regclass and contype = 'f'
                      and confrelid = 'public.s3_documents'::regclass and confdeltype = 'n'
                      and pg_get_constraintdef(oid) like '%(md_s3_document_id)%'),
         'связь с s3_documents: удалили файл — связь обнуляется'
  union all
  select 3, exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'idx_object_documents_md_s3'),
         'индекс idx_object_documents_md_s3'
  union all
  select 4, (select relrowsecurity from pg_class where oid = 'public.object_documents'::regclass),
         'object_documents: RLS на месте'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
