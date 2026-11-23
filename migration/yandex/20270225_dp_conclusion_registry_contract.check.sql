-- После 20270225_dp_conclusion_registry_contract: договор из «Заключения ДП» в работе, окно исполнителю; прежние договоры не тронуты.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
col as (
  select data_type, is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 'contracts' and column_name = 'doc_check_request_id'
),
fk as (
  select pg_get_constraintdef(oid) as def from pg_constraint
  where conrelid = 'public.contracts'::regclass and conname = 'contracts_doc_check_request_id_fkey' and contype = 'f'
),
fns as (
  select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg from pg_proc p
  where p.oid in (to_regprocedure('public.dp_conclusion_contract_create(uuid, text)'),
                  to_regprocedure('public.doc_check_dp_conclusion_contract()'),
                  to_regprocedure('public.doc_check_assign_alert()'),
                  to_regprocedure('public.doc_check_assign_my_alerts()'),
                  to_regprocedure('public.doc_check_assign_alerts_ack(uuid[])'))
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where data_type = 'uuid' and is_nullable = 'YES'),
         'contracts.doc_check_request_id: uuid, может быть пустым'
  union all
  select 2, coalesce((select def like '%REFERENCES doc_check_requests(id)%' and def like '%ON DELETE SET NULL%' from fk), false),
         'ссылка — на заявку доски, при её удалении пустеет'
  union all
  select 3, exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'contracts'
                      and indexname = 'contracts_doc_check_request_uniq' and indexdef like 'CREATE UNIQUE INDEX%'),
         'одна заявка — не больше одного договора (уникальный индекс)'
  union all
  select 4, (select count(*) = 5 and bool_and(prosecdef and cfg like '%application_name=osp:internal%') from fns),
         'пять служебных функций с отметкой osp:internal'
  union all
  select 5, (select count(*) = 2 from pg_trigger where tgrelid = 'public.doc_check_requests'::regclass and not tgisinternal
               and tgenabled = 'O' and tgname in ('doc_check_dp_conclusion_contract', 'doc_check_assign_alert')),
         'триггеры доски включены: договор при входе в работу и окно исполнителю'
  union all
  select 6, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.doc_check_assign_alerts'::regclass)
            and (select count(*) = 1 and bool_and(policyname = 'osp_internal') from pg_policies
                 where schemaname = 'public' and tablename = 'doc_check_assign_alerts'),
         'doc_check_assign_alerts: RLS включён, действует на владельца, только служебные операции'
  union all
  select 7, not exists (select 1 from public.contracts c
                        where c.doc_check_request_id is not null
                          and not exists (select 1 from public.doc_check_requests r
                                          where r.id = c.doc_check_request_id and r.doc_type = 'dp_conclusion')),
         'договоры со ссылкой — только из заявок «Заключение ДП»'
  union all
  select 8, not exists (select 1 from public.contracts c where c.doc_check_request_id is not null
                          and (c.record_type <> 'dp' or c.created_at < now() - interval '1 minute')),
         'ссылку получили только новые договоры подряда — прежние договоры не тронуты'
  union all
  select 9, not exists (select 1 from public.doc_check_assign_alerts),
         'уведомлений исполнителям ещё нет — назначения до миграции окна не вызывают'
  union all
  select 10, not exists (select 1 from public.doc_check_requests r
                         where r.doc_type = 'dp_conclusion' and r.deleted_at is null and r.status = 'in_progress'
                           and not exists (select 1 from public.contracts c where c.doc_check_request_id = r.id)
                           and not (r.object_id is not null and exists (
                             select 1 from public.contracts c
                             where c.record_type = 'dp' and c.deleted_at is null and c.object_id = r.object_id
                               and c.created_at >= date_trunc('day', r.created_at)
                               and (r.counterparty_id is null or c.counterparty_id = r.counterparty_id
                                    or exists (select 1 from public.contract_counterparties cc
                                               where cc.contract_id = c.id and cc.counterparty_id = r.counterparty_id))))),
         'у каждой заявки «Заключение ДП» в работе — договор или похожий договор, внесённый вручную'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
