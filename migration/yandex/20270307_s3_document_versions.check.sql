-- После 20270307_s3_document_versions: у файла — группа версий, база не даёт собрать в одну группу файлы разных списков; кабинет
-- подрядчика скрывает прежние версии ведомости; данные не тронуты.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
col as (
  select data_type, is_nullable, column_default from information_schema.columns
  where table_schema = 'public' and table_name = 's3_documents' and column_name = 'version_group_id'
),
fn as (
  select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg, pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('s3_documents_version_guard', 'bid_vor_superseded', 'bid_vor_changes', 's3_documents_user_guard')
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where data_type = 'uuid' and is_nullable = 'YES' and column_default is null),
         's3_documents.version_group_id: uuid, может быть пустым, без значения по умолчанию'
  union all
  select 2, exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 's3_documents'
                      and indexname = 's3_documents_version_group_idx'),
         's3_documents: индекс по группе версий'
  union all
  select 3, exists (select 1 from pg_trigger where tgrelid = 'public.s3_documents'::regclass
                      and tgname = 's3_documents_version_guard' and not tgisinternal and tgenabled <> 'D'),
         's3_documents: триггер — версии только у файлов одного списка'
  union all
  select 4, exists (select 1 from fn where proname = 's3_documents_version_guard' and prosecdef and cfg like '%osp:internal%'),
         'проверка версий — служебная функция (видит все строки)'
  union all
  select 5, exists (select 1 from fn where proname = 'bid_vor_superseded' and def like '%version_group_id%' and def like '%prior_document_ids%'),
         'bid_vor_superseded: прежние версии группы и отметка снабжения'
  union all
  select 6, exists (select 1 from fn where proname = 'bid_vor_changes' and def like '%version_group_id%'),
         'bid_vor_changes: прежняя версия — и среди версий группы'
  union all
  select 9, exists (select 1 from fn where proname = 's3_documents_user_guard' and def like '%''version_group_id''%' and def like '%s3_document_immutable%'),
         'правка строки файла пользователем: имя, описание и группа версий, прочее — отказ'
  union all
  select 7, not exists (select 1 from public.s3_documents where version_group_id is not null),
         's3_documents: групп версий ещё нет — данные не изменились'
  union all
  select 8, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.s3_documents'::regclass),
         's3_documents: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
