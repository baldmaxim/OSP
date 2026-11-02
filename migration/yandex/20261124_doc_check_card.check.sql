-- После 20261124_doc_check_card: карточка заявки на проверку ДП/ДС — обсуждение, шаги, ссылка на письмо, исполнители без
-- учётной записи. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
cols as (
  select column_name, udt_name from information_schema.columns
  where table_schema = 'public' and table_name = 'doc_check_requests'
),
pol as (
  select tablename, policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename in ('doc_check_request_comments', 'doc_check_request_steps')
),
checks(n, ok, what) as (
  select 1, exists (select 1 from cols where column_name = 'email_link' and udt_name = 'text')
            and exists (select 1 from cols where column_name = 'manual_assignees' and udt_name = '_text')
            and (select count(*) from pg_constraint where conrelid = 'public.doc_check_requests'::regclass
                   and conname in ('doc_check_requests_email_link_check', 'doc_check_requests_manual_assignees_check')) = 2,
         'заявки: ссылка на письмо (только http(s)) и исполнители без учётной записи'
  union all
  select 2, (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname in ('doc_check_request_comments', 'doc_check_request_steps')
               and c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity) = 2,
         'обсуждение и шаги: таблицы есть, правила по строкам включены и действуют на владельца'
  union all
  select 3, (select count(*) from pol where policyname = 'osp_internal') = 2
            and (select count(*) from pol where policyname <> 'osp_internal' and qual || chk like '%role_in(%authenticated%') = 6,
         'пропуск служебных операций; остальные правила — по роли из токена'
  union all
  select 4, (select count(*) from pol where tablename = 'doc_check_request_comments' and policyname <> 'osp_internal') = 2
            and not exists (select 1 from pol where tablename = 'doc_check_request_comments' and cmd in ('UPDATE', 'DELETE', 'ALL') and policyname <> 'osp_internal'),
         'обсуждение: читает и пишет, кто видит раздел; правки и удаления сообщений нет'
  union all
  select 5, exists (select 1 from pol where tablename = 'doc_check_request_steps' and cmd = 'INSERT' and chk like '%osp_can%edit%')
            and exists (select 1 from pol where tablename = 'doc_check_request_steps' and cmd = 'DELETE' and qual like '%osp_can%edit%')
            and exists (select 1 from pol where tablename = 'doc_check_request_steps' and cmd = 'UPDATE' and qual like '%assignee_ids%' and chk like '%assignee_ids%'),
         'шаги: добавляет и удаляет право правки раздела; отмечает ещё и исполнитель'
  union all
  select 6, (select count(*) from osp_meta.policy_roles where schema_name = 'public'
               and table_name in ('doc_check_request_comments', 'doc_check_request_steps') and roles = array['authenticated']) = 6,
         'записи о ролях шести правил'
  union all
  select 7, exists (select 1 from pg_trigger tg where tg.tgrelid = 'public.doc_check_request_comments'::regclass
                      and tg.tgname = 'doc_check_request_comments_stamp' and not tg.tgisinternal)
            and exists (select 1 from pg_trigger tg where tg.tgrelid = 'public.doc_check_request_steps'::regclass
                      and tg.tgname = 'doc_check_request_steps_guard' and not tg.tgisinternal),
         'триггеры: автор и время сообщения, граница права исполнителя у шагов'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
