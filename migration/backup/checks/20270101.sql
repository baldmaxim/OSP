-- Проверка после 20270101_doc_check_object_scope.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции; до миграции отвечает FAIL, а не падает.
with
fn as (
  select p.prosecdef, p.provolatile, pg_get_functiondef(p.oid) def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'doc_check_scope' and p.pronargs = 0
),
pol as (
  select tablename, policyname, roles, coalesce(qual, '') qual, coalesce(with_check, '') chk
  from pg_policies
  where schemaname = 'public'
    and tablename in ('doc_check_requests', 'doc_check_request_audit_log', 'doc_check_request_comments', 'doc_check_request_steps')
),
tbl as (
  select c.relname, c.relrowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('doc_check_requests', 'doc_check_request_audit_log', 'doc_check_request_comments', 'doc_check_request_steps')
),
perm as (
  select r.key, rp.can_view, rp.can_edit
  from public.roles r
  left join public.role_permissions rp on rp.role = r.key and rp.section = 'doc_check_requests'
  where r.key in ('construction_manager', 'economist_object')
),
checks(n, ok, what) as (
  select 1, exists (select 1 from fn where prosecdef and provolatile = 's' and def like '%is_admin()%' and def like '%object_ids%'),
         'doc_check_scope(): объекты вошедшего; администратору — все'
  union all
  select 2, (select count(*) from pol) = 8,
         'правил заявок, истории, обсуждения и шагов — прежние 8, лишних нет'
  union all
  select 3, (select count(*) from pol) > 0
            and not exists (select 1 from pol where (qual <> '' and qual not like '%doc_check_scope()%')
                                                 or (chk <> '' and chk not like '%doc_check_scope()%')),
         'каждое правило (и чтение, и запись) ограничено объектами вошедшего'
  union all
  select 4, not exists (select 1 from pol where roles <> '{authenticated}'::name[]),
         'правила — только для вошедших'
  union all
  select 5, (select count(*) from tbl where relrowsecurity) = 4,
         'четыре таблицы: RLS включён'
  union all
  select 6, not exists (select 1 from perm where can_view is distinct from true or can_edit is distinct from false),
         'руководитель строительства и экономист объекта: просмотр без правки'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
