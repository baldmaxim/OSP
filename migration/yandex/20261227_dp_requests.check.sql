-- После 20261227_dp_requests: заявка на ДП — таблицы, запрет без понятийного соглашения, уведомления только функциями, права по
-- ролям. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
pol as (
  select tablename, policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename in ('dp_requests', 'dp_request_alert_recipients', 'dp_request_alerts')
),
fn as (
  select p.proname, p.prosecdef, p.proconfig, p.prosrc from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public' and p.proname in ('dp_requests_guard', 'dp_requests_alert', 's3_documents_dp_request_guard',
                                               'dp_request_scope', 'dp_request_my_alerts', 'dp_request_alerts_ack')
),
checks(n, ok, what) as (
  select 1, (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname in ('dp_requests', 'dp_request_alert_recipients', 'dp_request_alerts')
               and c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity) = 3,
         'таблицы есть, правила по строкам включены и действуют на владельца'
  union all
  select 2, (select count(*) from pol where policyname = 'osp_internal') = 3
            and (select count(*) from pol where policyname <> 'osp_internal' and qual || chk like '%role_in(%authenticated%') = 7,
         'пропуск служебных операций; остальные правила — по роли из токена'
  union all
  select 3, not exists (select 1 from pol where tablename = 'dp_request_alerts' and policyname <> 'osp_internal'),
         'уведомления: правил для вошедших нет — только функциями'
  union all
  select 4, (select count(*) from osp_meta.policy_roles where schema_name = 'public'
               and table_name in ('dp_requests', 'dp_request_alert_recipients') and roles = array['authenticated']) = 7,
         'записи о ролях семи правил'
  union all
  select 5, exists (select 1 from pg_trigger t where t.tgrelid = 'public.dp_requests'::regclass and t.tgname = 'dp_requests_guard' and t.tgenabled = 'O')
            and exists (select 1 from pg_trigger t where t.tgrelid = 'public.dp_requests'::regclass and t.tgname = 'dp_requests_alert' and t.tgenabled = 'O')
            and (select prosrc like '%dp_concept_agreement_required%' and prosrc like '%dp_contract_doc_required%' from fn where proname = 'dp_requests_guard'),
         'заявка не подаётся без понятийного соглашения и документа договора; при подаче заводятся уведомления'
  union all
  select 6, (select count(*) from pg_trigger t where t.tgrelid = 'public.s3_documents'::regclass
               and t.tgname in ('s3_documents_dp_request_attach', 's3_documents_dp_request_detach')
               and t.tgenabled = 'O' and pg_get_triggerdef(t.oid) like '%dp_request%WHEN%') = 2,
         'файлы заявки: граница права и последний обязательный файл; триггеры срабатывают только на файлах заявок'
  union all
  select 7, (select count(*) from fn where proname in ('dp_requests_alert', 'dp_request_scope', 'dp_request_my_alerts', 'dp_request_alerts_ack')
               and prosecdef and proconfig @> array['application_name=osp:internal']) = 4
            and (select count(*) from fn where proname in ('dp_requests_guard', 's3_documents_dp_request_guard') and not prosecdef) = 2,
         'служебные функции — с отметкой пропуска; запреты — с правами вызывающего'
  union all
  select 8, (select count(*) from public.role_permissions p join public.roles r on r.key = p.role
             where p.section = 'dp_requests_create' and p.can_edit and p.role in ('economist_object', 'construction_manager'))
            = (select count(*) from public.roles where key in ('economist_object', 'construction_manager'))
            and not exists (select 1 from public.role_permissions where section = 'dp_requests' and can_edit and role in ('economist_object', 'construction_manager')),
         'создают экономист объекта и руководитель строительства; работают с заявками — другие роли'
  union all
  select 9, (select count(*) from public.dp_request_alert_recipients r
             where r.user_id in ('c12b7fec-2ff6-4804-ae8b-604ffcb4c2e8', 'c6e89e48-fa2e-44ce-aae7-54f5d7289e46'))
            = (select count(*) from public.user_roles u
               where u.user_id in ('c12b7fec-2ff6-4804-ae8b-604ffcb4c2e8', 'c6e89e48-fa2e-44ce-aae7-54f5d7289e46')),
         'начальные получатели уведомлений занесены (кто есть в этой базе)'
)
select case when ok is true then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
