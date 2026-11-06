-- После 20270101_doc_check_object_scope: заявки на проверку ДП/ДС, их история, обсуждение и шаги сотруднику с привязкой
-- к объектам — только своих объектов; руководитель строительства и экономист объекта — просмотр без правки.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
fn as (
  select p.prosecdef, p.provolatile, coalesce(p.proconfig, '{}') cfg, pg_get_functiondef(p.oid) def
  from pg_proc p
  where p.oid = 'public.doc_check_scope()'::regprocedure
),
pol as (
  select tablename, policyname, coalesce(qual, '') qual, coalesce(with_check, '') chk
  from pg_policies
  where schemaname = 'public'
    and tablename in ('doc_check_requests', 'doc_check_request_audit_log', 'doc_check_request_comments', 'doc_check_request_steps')
    and policyname <> 'osp_internal'
),
tbl as (
  select c.relname, c.relrowsecurity, c.relforcerowsecurity
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
  select 1, exists (select 1 from fn where prosecdef and provolatile = 's' and 'application_name=osp:internal' = any (cfg)
                                       and def like '%is_admin()%' and def like '%object_ids%'),
         'doc_check_scope(): объекты вошедшего, с отметкой пропуска; администратору — все'
  union all
  select 2, (select count(*) from pol) = 8,
         'правил заявок, истории, обсуждения и шагов — прежние 8, лишних нет'
  union all
  select 3, not exists (select 1 from pol where (qual <> '' and qual not like '%doc_check_scope()%')
                                             or (chk <> '' and chk not like '%doc_check_scope()%')),
         'каждое правило (и чтение, и запись) ограничено объектами вошедшего'
  union all
  select 4, exists (select 1 from pol where tablename = 'doc_check_requests' and qual like '%is_negotiation_employee()%'
                                         and chk like '%is_negotiation_employee()%'),
         'заявки: прежнее условие «сотрудник» на месте'
  union all
  select 5, exists (select 1 from pol where policyname = 'doc_check_request_steps_update' and qual like '%assignee_ids%'),
         'шаги: исполнитель заявки по-прежнему отмечает шаг'
  union all
  select 6, (select count(*) from tbl where relrowsecurity and relforcerowsecurity) = 4,
         'четыре таблицы: RLS включён и действует на владельца'
  union all
  select 7, not exists (select 1 from perm where can_view is distinct from true or can_edit is distinct from false),
         'руководитель строительства и экономист объекта: просмотр без правки'
  union all
  select 8, (select count(*) from osp_meta.policy_roles
             where schema_name = 'public' and policy_name in (select policyname from pol)) = 8,
         'роли всех 8 правил записаны (osp_meta.policy_roles)'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
