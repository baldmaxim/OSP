-- Проверка после 20261124_doc_check_card.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: объекты ищутся через to_regclass и каталог.
with
cols as (
  select column_name, udt_name from information_schema.columns
  where table_schema = 'public' and table_name = 'doc_check_requests'
),
pol as (
  select tablename, policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk, roles from pg_policies
  where schemaname = 'public' and tablename in ('doc_check_request_comments', 'doc_check_request_steps')
),
checks(n, ok, what) as (
  select 1, exists (select 1 from cols where column_name = 'email_link' and udt_name = 'text')
            and exists (select 1 from cols where column_name = 'manual_assignees' and udt_name = '_text')
            and (select count(*) from pg_constraint where conrelid = 'public.doc_check_requests'::regclass
                   and conname in ('doc_check_requests_email_link_check', 'doc_check_requests_manual_assignees_check')) = 2,
         'заявки: ссылка на письмо (только http(s)) и исполнители без учётной записи'
  union all
  select 2, coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.doc_check_request_comments')), false)
            and coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.doc_check_request_steps')), false),
         'обсуждение и шаги: таблицы созданы, RLS включён'
  union all
  select 3, (select count(*) from pol where tablename = 'doc_check_request_comments' and roles = '{authenticated}') = 2
            and not exists (select 1 from pol where tablename = 'doc_check_request_comments' and cmd in ('UPDATE', 'DELETE', 'ALL')),
         'обсуждение: читает и пишет, кто видит раздел; правки и удаления сообщений нет'
  union all
  select 4, (select count(*) from pol where tablename = 'doc_check_request_steps' and roles = '{authenticated}') = 4
            and exists (select 1 from pol where tablename = 'doc_check_request_steps' and cmd = 'INSERT' and chk like '%osp_can%edit%')
            and exists (select 1 from pol where tablename = 'doc_check_request_steps' and cmd = 'DELETE' and qual like '%osp_can%edit%')
            and exists (select 1 from pol where tablename = 'doc_check_request_steps' and cmd = 'UPDATE' and qual like '%assignee_ids%' and chk like '%assignee_ids%'),
         'шаги: добавляет и удаляет право правки раздела; отмечает ещё и исполнитель'
  union all
  select 5, coalesce(not has_table_privilege('anon', to_regclass('public.doc_check_request_comments'), 'select'), false)
            and coalesce(not has_table_privilege('anon', to_regclass('public.doc_check_request_steps'), 'select'), false),
         'гостю ничего не выдано'
  union all
  select 6, coalesce(not has_table_privilege('authenticated', to_regclass('public.doc_check_request_comments'), 'update'), false)
            and coalesce(not has_table_privilege('authenticated', to_regclass('public.doc_check_request_comments'), 'delete'), false),
         'сообщения нельзя изменить и удалить: права не выданы'
  union all
  select 7, exists (select 1 from pg_trigger tg where tg.tgrelid = to_regclass('public.doc_check_request_comments')
                      and tg.tgname = 'doc_check_request_comments_stamp' and not tg.tgisinternal)
            and exists (select 1 from pg_trigger tg where tg.tgrelid = to_regclass('public.doc_check_request_steps')
                      and tg.tgname = 'doc_check_request_steps_guard' and not tg.tgisinternal),
         'триггеры: автор и время сообщения, граница права исполнителя у шагов'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
