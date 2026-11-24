-- После 20270226_registry_osp_lawyers: юрист договора — учётка действующего юриста ОСП, договор из «Заключения ДП» — сразу при подаче.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
col as (
  select data_type, is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 'contracts' and column_name = 'responsible_user_id'
),
fns as (
  select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg from pg_proc p
  where p.oid in (to_regprocedure('public.osp_is_active_lawyer(uuid)'),
                  to_regprocedure('public.osp_first_lawyer(uuid[])'),
                  to_regprocedure('public.osp_user_display_name(uuid)'),
                  to_regprocedure('public.dp_conclusion_contract_create(uuid, text)'),
                  to_regprocedure('public.doc_check_dp_conclusion_contract()'),
                  to_regprocedure('public.contracts_lawyer_guard()'),
                  to_regprocedure('public.list_osp_lawyers()'))
),
law as (
  select ur.user_id from public.user_roles ur
  where ur.role = 'lawyer' and ur.is_approved and ur.counterparty_id is null
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where data_type = 'uuid' and is_nullable = 'YES'),
         'contracts.responsible_user_id: uuid, может быть пустым'
  union all
  select 2, (select count(*) = 7 and bool_and(prosecdef and cfg like '%application_name=osp:internal%') from fns),
         'семь служебных функций с отметкой osp:internal'
  union all
  select 3, exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                    where t.tgrelid = 'public.contracts'::regclass and t.tgname = 'contracts_lawyer_guard'
                      and not t.tgisinternal and t.tgenabled = 'O' and p.prosecdef),
         'на договорах — проверка юриста (contracts_lawyer_guard)'
  union all
  select 4, exists (select 1 from pg_trigger where tgrelid = 'public.doc_check_requests'::regclass and not tgisinternal
                      and tgname = 'doc_check_dp_conclusion_contract' and tgenabled = 'O'
                      and pg_get_triggerdef(oid) like '%assignee_ids%' and pg_get_triggerdef(oid) not like '%status <> %'),
         'триггер доски: договор при подаче, смена колонки и исполнителей'
  union all
  select 5, not exists (select 1 from public.contracts c where c.responsible_user_id is not null
                          and not exists (select 1 from law where law.user_id = c.responsible_user_id)),
         'юрист договора — только действующий юрист ОСП'
  union all
  select 6, not exists (select 1 from public.contracts c
                        where c.responsible_contact_id is not null and c.responsible_user_id is null
                          and not exists (select 1 from public.contract_audit_log l where l.contract_id = c.id
                                            and l.field_name = 'responsible_user_id' and l.description like 'Ответственный юрист «%» снят:%')),
         'каждый договор с прежним юристом — либо с учёткой юриста, либо со следом «снят» в «Истории»'
  union all
  select 7, not exists (select 1 from public.doc_check_requests r
                        where r.doc_type = 'dp_conclusion' and r.deleted_at is null
                          and not exists (select 1 from public.contracts c where c.doc_check_request_id = r.id)
                          and not (r.object_id is not null and exists (
                            select 1 from public.contracts c
                            where c.record_type = 'dp' and c.deleted_at is null and c.object_id = r.object_id
                              and c.created_at >= date_trunc('day', r.created_at) and c.doc_check_request_id is null
                              and (r.counterparty_id is null or c.counterparty_id = r.counterparty_id
                                   or exists (select 1 from public.contract_counterparties cc
                                              where cc.contract_id = c.id and cc.counterparty_id = r.counterparty_id))))),
         'у каждой живой заявки «Заключение ДП» — договор или похожий договор, внесённый вручную'
  union all
  select 8, not exists (select 1 from public.contracts c join public.doc_check_requests r on r.id = c.doc_check_request_id
                        where c.created_at >= now() - interval '1 minute'
                          and c.status <> case when r.status = 'new' then 'new_request' else 'in_work' end),
         'новые договоры из заявок: «Новые» — «Новая заявка», остальные колонки — «В работе»'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks
union all
select 'OK юрист перенесён на учётку юриста ОСП: ' || (select count(*) from public.contracts where responsible_user_id is not null)
  || ', снят (не действующий юрист ОСП): ' || (select count(*) from public.contracts where responsible_contact_id is not null and responsible_user_id is null)
union all
select 'OK договоров из заявок «Заключение ДП»: ' || (select count(*) from public.contracts where doc_check_request_id is not null);
