-- Проверка после 20261227_dp_requests.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: смотрит только каталог и таблицы, которые есть всегда.
with
tbl as (
  select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname in ('dp_requests', 'dp_request_alert_recipients', 'dp_request_alerts')
),
pol as (
  select tablename, policyname, cmd, roles from pg_policies
  where schemaname = 'public' and tablename in ('dp_requests', 'dp_request_alert_recipients', 'dp_request_alerts')
),
fn as (
  select p.proname, p.prosecdef, p.prosrc from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public' and p.proname in ('dp_requests_guard', 'dp_requests_alert', 's3_documents_dp_request_guard',
                                               'dp_request_scope', 'dp_request_my_alerts', 'dp_request_alerts_ack')
),
trg as (
  select c.relname, t.tgname, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
    and t.tgname in ('dp_requests_guard', 'dp_requests_alert', 's3_documents_dp_request_attach', 's3_documents_dp_request_detach')
),
checks(n, ok, what) as (
  select 1, (select count(*) from tbl where relrowsecurity) = 3, 'таблицы заявок, получателей и уведомлений: правила по строкам включены'
  union all
  select 2, (select count(*) from pol where tablename = 'dp_requests') = 4
            and (select count(*) from pol where tablename = 'dp_request_alert_recipients') = 3,
         'правила заявок и получателей на месте'
  union all
  select 3, not exists (select 1 from pol where tablename = 'dp_request_alerts')
            and (select count(*) from tbl where relname = 'dp_request_alerts') = 1,
         'уведомления: правил для вошедших нет — только функциями'
  union all
  select 4, (select count(*) from trg where tgenabled = 'O') = 4, 'триггеры заявок и файлов заявок включены'
  union all
  select 5, coalesce((select prosrc like '%dp_concept_agreement_required%' from fn where proname = 'dp_requests_guard'), false),
         'заявка не подаётся без понятийного соглашения'
  union all
  select 6, (select count(*) from fn where proname in ('dp_requests_guard', 's3_documents_dp_request_guard') and not prosecdef) = 2
            and (select count(*) from fn where proname in ('dp_requests_alert', 'dp_request_scope', 'dp_request_my_alerts', 'dp_request_alerts_ack') and prosecdef) = 4,
         'запреты — с правами вызывающего, функции уведомлений — служебные'
  union all
  select 7, (select count(*) from public.role_permissions p
             where p.section = 'dp_requests_create' and p.can_edit and p.role in ('economist_object', 'construction_manager'))
            = (select count(*) from public.roles where key in ('economist_object', 'construction_manager'))
            and not exists (select 1 from public.role_permissions where section = 'dp_requests' and can_edit and role in ('economist_object', 'construction_manager')),
         'создают экономист объекта и руководитель строительства; работают с заявками — другие роли'
)
select case when ok is true then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
