-- После 20270121_audit_trail: журнал изменений от базы и защищённые журналы для экрана.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
parents(t) as (values ('contracts'), ('tenders'), ('counterparties'), ('dc_requests'), ('doc_check_requests'), ('tasks')),
logs(t) as (values ('contract_audit_log'), ('tender_audit_log'), ('counterparty_audit_log'), ('dc_request_audit_log'),
                   ('doc_check_request_audit_log'), ('task_audit_log')),
trg as (
  select c.relname, t.tgname, t.tgenabled
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
),
fn as (
  select p.proname, p.prosecdef, coalesce(p.proconfig, '{}') cfg
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname, p.proname) in (('osp_private', 'data_audit_write'), ('osp_private', 'data_audit_row'),
                                   ('public', 'audit_log_stamp'), ('public', 'audit_log_guard'), ('public', 'audit_log_parent_exists'))
),
log_tbl as (
  select c.relrowsecurity, c.relforcerowsecurity,
         (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'osp_private' and c.relname = 'data_audit_log'
),
checks(n, ok, what) as (
  select 1, exists (select 1 from log_tbl where relrowsecurity and relforcerowsecurity and policies = 1),
         'osp_private.data_audit_log: только служебные операции (одно правило — пропуск)'
  union all
  select 2, (select count(*) from parents p where exists (select 1 from trg where relname = p.t and tgname = 'osp_data_audit' and tgenabled <> 'D')) = 6,
         'триггер журнала базы на шести бизнес-таблицах'
  union all
  select 3, (select count(*) from logs l where exists (select 1 from trg where relname = l.t and tgname = 'audit_log_stamp')
                                      and exists (select 1 from trg where relname = l.t and tgname = 'audit_log_guard')) = 6,
         'журналы для экрана: автор от сервера и запрет правки на шести таблицах'
  union all
  select 4, (select count(*) from logs l where exists (select 1 from information_schema.columns c
                                                    where c.table_schema = 'public' and c.table_name = l.t and c.column_name = 'changed_by')) = 6,
         'колонка changed_by в шести журналах'
  union all
  select 5, exists (select 1 from fn where proname = 'data_audit_write' and prosecdef and 'application_name=osp:internal' = any (cfg))
            and exists (select 1 from fn where proname = 'audit_log_parent_exists' and prosecdef and 'application_name=osp:internal' = any (cfg))
            and exists (select 1 from fn where proname = 'data_audit_row' and not prosecdef)
            and exists (select 1 from fn where proname = 'audit_log_stamp' and not prosecdef)
            and exists (select 1 from fn where proname = 'audit_log_guard' and not prosecdef),
         'функции: запись и проверка родителя — служебные, триггеры — в контексте вызывающего'
  union all
  select 6, has_schema_privilege('public', 'osp_private', 'USAGE') is false,
         'закрытая схема «всем» недоступна'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
