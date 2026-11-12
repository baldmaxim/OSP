-- После 20270216_doc_check_chat_history: файлы в обсуждении (снимок в сообщении, отправленный файл не меняется и не
-- удаляется), история заявки от базы, ответственный за согласование ПСДЦ, «прочитано» у каждого сотрудника, отпечаток объекта.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
col as (
  select table_name, column_name, data_type, is_nullable
  from information_schema.columns
  where table_schema = 'public'
    and (table_name, column_name) in (('doc_check_requests', 'psdc_responsible_id'), ('doc_check_request_comments', 'attachments'),
                                      ('s3_documents', 'content_etag'))
),
tbl as (
  select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'doc_check_talk_reads' and c.relkind = 'r'
),
pol as (
  select policyname from pg_policies where schemaname = 'public' and tablename = 'doc_check_talk_reads'
),
fn as (
  select p.proname, p.prosecdef, coalesce(p.proconfig, '{}') cfg, pg_get_functiondef(p.oid) def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('doc_check_requests_psdc_guard', 'doc_check_history_write', 'doc_check_audit_log_server_only',
    'doc_check_requests_history', 's3_documents_doc_check_history', 'doc_check_request_comments_stamp', 'doc_check_request_comments_history',
    's3_documents_doc_check_guard', 'doc_check_talk_state', 'doc_check_talk_mark', 'doc_check_keep_history')
),
trg as (
  select t.tgname, c.relname, t.tgenabled, pg_get_triggerdef(t.oid) def
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
    and t.tgname in ('doc_check_requests_psdc_guard', 'doc_check_requests_history', 'doc_check_audit_log_server_only',
                     's3_documents_doc_check_history_ins', 's3_documents_doc_check_history_upd', 's3_documents_doc_check_history_del',
                     'doc_check_request_comments_history', 'doc_check_request_comments_stamp',
                     's3_documents_doc_check_attach', 's3_documents_doc_check_detach',
                     'doc_check_audit_log_keep', 'doc_check_requests_keep_history')
),
con as (
  select conname, pg_get_constraintdef(oid) def from pg_constraint
  where conrelid = to_regclass('public.doc_check_request_comments')
    and conname in ('doc_check_request_comments_body_check', 'doc_check_request_comments_attachments_check')
),
checks(n, ok, what) as (
  select 1, (select count(*) from col) = 3
            and exists (select 1 from col where column_name = 'attachments' and data_type = 'jsonb' and is_nullable = 'NO'),
         'колонки: ответственный за ПСДЦ, файлы сообщения (jsonb, не пусто), отпечаток объекта хранилища'
  union all
  select 2, exists (select 1 from con where conname = 'doc_check_request_comments_body_check' and def like '%jsonb_array_length(attachments)%')
            and exists (select 1 from con where conname = 'doc_check_request_comments_attachments_check' and def like '%20%'),
         'сообщение — текст или файлы, не больше 20 файлов'
  union all
  select 3, (select count(*) from fn where prosecdef and 'application_name=osp:internal' = any (cfg)
               and proname in ('doc_check_history_write', 'doc_check_requests_history', 's3_documents_doc_check_history',
                               'doc_check_request_comments_history', 'doc_check_requests_psdc_guard', 'doc_check_talk_state',
                               'doc_check_talk_mark', 'doc_check_keep_history')) = 8
            and exists (select 1 from fn where proname = 'doc_check_history_write' and 'application_name=osp:internal' = any (cfg))
            and exists (select 1 from fn where proname = 'doc_check_audit_log_server_only' and not prosecdef
                          and def like '%current_setting(''application_name'', true) = ''osp:internal''%'),
         'история пишется базой: служебные функции с отметкой пропуска, запись страницы отбрасывается'
  union all
  select 4, exists (select 1 from fn where proname = 's3_documents_doc_check_guard' and not prosecdef
                      and not ('application_name=osp:internal' = any (cfg))
                      and def like '%doc_check_chat_file_locked%' and def like '%s3_document_immutable%' and def like '%doc_check_file_edit%')
            and exists (select 1 from fn where proname = 'doc_check_request_comments_stamp' and not prosecdef
                          and def like '%doc_check_chat_file_foreign%' and def like '%doc_check_chat_file_posted%'),
         'файлы заявки (права вызывающего): файл обсуждения не меняется и не удаляется, строка файла — только имя и описание'
  union all
  select 5, (select count(*) from trg where tgenabled = 'O') = 12
            and exists (select 1 from trg where tgname = 'doc_check_requests_history' and def like '%AFTER INSERT OR UPDATE%')
            and exists (select 1 from trg where tgname = 'doc_check_audit_log_server_only' and def like '%BEFORE INSERT%')
            and exists (select 1 from trg where tgname = 'doc_check_requests_psdc_guard' and def like '%BEFORE INSERT OR UPDATE OF psdc_responsible_id%'),
         'триггеры: история заявки, файлов и сообщений, её неизменность, ответственный за ПСДЦ, защита файлов — все включены'
  union all
  select 6, exists (select 1 from tbl where relrowsecurity and relforcerowsecurity)
            and (select array_agg(policyname) from pol) = array['osp_internal']::name[],
         '«прочитано»: правила действуют на владельца, доступ — только служебным операциям (функциям)'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
