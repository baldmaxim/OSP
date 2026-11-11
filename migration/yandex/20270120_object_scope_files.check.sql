-- После 20270120_object_scope_files: охват по объектам договоров и привязанного к ним, чтение и неизменность строк файлов,
-- учёт загрузок, настройки разделов, свой профиль. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh),
-- с отметкой служебной операции.
with
scoped(t) as (values ('contracts'), ('object_contract_attachments'), ('contract_advance_schedule'), ('contract_appendices'),
                     ('contract_attachments'), ('contract_audit_log'), ('contract_clause_disputes'), ('contract_clauses'),
                     ('contract_counterparties'), ('contract_psdc_items'), ('counterparty_contract_links'),
                     ('contract_clause_comments'), ('contract_clause_dispute_clauses')),
pol as (
  select p.tablename, p.policyname, coalesce(p.qual, '') qual, coalesce(p.with_check, '') chk
  from pg_policies p
  where p.schemaname = 'public' and p.policyname <> 'osp_internal'
),
fn as (
  select p.proname, p.prosecdef, coalesce(p.proconfig, '{}') cfg, pg_get_functiondef(p.oid) def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('osp_object_scope', 'osp_contract_in_scope', 'dp_request_scope', 'doc_check_scope', 'psdc_object_in_scope',
                      'profile_update_own', 'app_settings_write_guard', 's3_documents_user_guard')
),
trg as (
  select c.relname, t.tgname
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
),
checks(n, ok, what) as (
  select 1, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'roles' and column_name = 'object_scoped')
            and (select count(*) from public.roles where key in ('construction_manager', 'economist_object') and object_scoped) =
                (select count(*) from public.roles where key in ('construction_manager', 'economist_object')),
         'роли «по объектам»: руководитель строительства и экономист объекта'
  union all
  select 2, (select count(*) from fn where proname in ('osp_object_scope', 'osp_contract_in_scope', 'dp_request_scope', 'doc_check_scope',
                                                      'psdc_object_in_scope', 'profile_update_own')
                                     and prosecdef and 'application_name=osp:internal' = any (cfg)) = 6,
         'функции охвата и профиля — служебные, с отметкой пропуска'
  union all
  select 3, (select count(*) from fn where proname in ('dp_request_scope', 'doc_check_scope', 'psdc_object_in_scope') and def like '%osp_object_scope()%') = 3,
         'охват заявок на ДП, заявок на проверку и ПСДЦ — одним правилом'
  union all
  select 4, not exists (select 1 from pol where tablename in (select t from scoped)
                         and not ((qual = '' or qual like '%osp_object_scope()%') and (chk = '' or chk like '%osp_object_scope()%'))),
         'у всех правил договоров и привязанного к ним — условие охвата (USING и WITH CHECK): '
           || (select count(*) from pol where tablename in (select t from scoped))
  union all
  select 5, exists (select 1 from pol where tablename = 's3_documents' and policyname = 'portal_employee_all'
                     and qual like '%osp_contract_in_scope(owner_id)%' and qual like '%can_see_task(owner_id)%'),
         'строки файлов: сотрудник видит файл, только если видит владельца'
  union all
  select 6, exists (select 1 from trg where relname = 's3_documents' and tgname = 's3_documents_user_guard'),
         'строки файлов: менять можно только имя и описание, автора ставит сервер'
  union all
  select 7, exists (select 1 from trg where relname = 'app_settings' and tgname = 'app_settings_write_guard'),
         'настройки разделов: ключ пишет правка своего раздела'
  union all
  select 8, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'osp_private.s3_upload_intents'::regclass)
            and (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'osp_private.policy_backup_20270120'::regclass),
         'учёт загрузок и копия правил — только служебным операциям'
  union all
  select 9, (select count(*) from osp_private.policy_backup_20270120) = (select count(*) from pol where tablename in (select t from scoped)) + 1,
         'копия прежних правил на месте (для отката): ' || (select count(*) from osp_private.policy_backup_20270120)
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
