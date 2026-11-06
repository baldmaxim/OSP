-- После 20270102_doc_check_create: заявки на проверку ДП/ДС меняет только право правки раздела, право создания — только новая
-- заявка в «Новых заявках»; файлы заявки — так же; руководитель строительства и экономист объекта — право создания.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
col as (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'doc_check_requests' and column_name = 'created_by' and data_type = 'uuid'
),
fn as (
  select p.proname, p.prosecdef, coalesce(p.proconfig, '{}') cfg, pg_get_functiondef(p.oid) def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('doc_check_requests_write_guard', 's3_documents_doc_check_guard') and p.pronargs = 0
),
trg as (
  select t.tgname, c.relname, t.tgenabled, pg_get_triggerdef(t.oid) def
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
    and t.tgname in ('doc_check_requests_write_guard', 's3_documents_doc_check_attach', 's3_documents_doc_check_detach')
),
perm as (
  select r.key, rp.can_view, rp.can_edit
  from public.roles r
  left join public.role_permissions rp on rp.role = r.key and rp.section = 'doc_check_requests_create'
  where r.key in ('construction_manager', 'economist_object')
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col), 'doc_check_requests.created_by — кто создал заявку'
  union all
  select 2, exists (select 1 from fn where proname = 'doc_check_requests_write_guard' and prosecdef
                      and 'application_name=osp:internal' = any (cfg)
                      and def like '%osp_can(''doc_check_requests'', ''edit'')%'
                      and def like '%osp_can(''doc_check_requests_create'', ''edit'')%'
                      and def like '%doc_check_create_new_only%'),
         'триггерная функция заявок (служебная, с отметкой пропуска): правка — право раздела, создание — только «Новые заявки»'
  union all
  select 3, exists (select 1 from trg where tgname = 'doc_check_requests_write_guard' and relname = 'doc_check_requests'
                      and tgenabled = 'O' and def like '%BEFORE INSERT OR DELETE OR UPDATE%' and def like '%FOR EACH ROW%'),
         'триггер заявок: до вставки, правки и удаления каждой строки, включён'
  union all
  select 4, exists (select 1 from fn where proname = 's3_documents_doc_check_guard' and not prosecdef and not ('application_name=osp:internal' = any (cfg)))
            and (select count(*) from trg where relname = 's3_documents' and tgenabled = 'O') = 2,
         'файлы заявок: два триггера s3_documents, функция с правами вызывающего'
  union all
  select 5, not exists (select 1 from perm where can_view is distinct from true or can_edit is distinct from true),
         'руководитель строительства и экономист объекта: право создания заявок'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
