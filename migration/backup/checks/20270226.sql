-- Проверка после 20270226_registry_osp_lawyers.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции; до миграции отвечает FAIL, а не падает.
-- Последние строки — числа для отчёта: сколько договоров получили учётку юриста, у скольких юрист снят, сколько договоров из заявок.
with
col as (
  select data_type, is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 'contracts' and column_name = 'responsible_user_id'
),
law as (
  select ur.user_id from public.user_roles ur
  where ur.role = 'lawyer' and ur.is_approved and ur.counterparty_id is null
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where data_type = 'uuid' and is_nullable = 'YES'),
         'contracts.responsible_user_id: uuid, может быть пустым'
  union all
  select 2, to_regprocedure('public.osp_is_active_lawyer(uuid)') is not null
            and to_regprocedure('public.osp_first_lawyer(uuid[])') is not null
            and to_regprocedure('public.contracts_lawyer_guard()') is not null
            and to_regprocedure('public.list_osp_lawyers()') is not null,
         'функции правила «действующий юрист ОСП», проверки договора и списка юристов'
  union all
  select 3, exists (select 1 from pg_trigger where tgrelid = 'public.contracts'::regclass and not tgisinternal
                      and tgname = 'contracts_lawyer_guard'),
         'на договорах — проверка юриста'
  union all
  select 4, exists (select 1 from pg_trigger where tgrelid = 'public.doc_check_requests'::regclass and not tgisinternal
                      and tgname = 'doc_check_dp_conclusion_contract' and pg_get_triggerdef(oid) like '%assignee_ids%'),
         'триггер доски: договор при подаче и перенос исполнителя'
  union all
  select 5, exists (select 1 from col) and not exists (
              select 1 from public.contracts c where to_jsonb(c) ->> 'responsible_user_id' is not null
                and not exists (select 1 from law where law.user_id::text = to_jsonb(c) ->> 'responsible_user_id')),
         'юрист договора — действующий юрист ОСП (сразу после миграции; позже заблокированный юрист остаётся в базе скрытым)'
  union all
  select 6, exists (select 1 from col) and not exists (
              select 1 from public.doc_check_requests r
              where r.doc_type = 'dp_conclusion' and r.deleted_at is null
                and not exists (select 1 from public.contracts c where to_jsonb(c) ->> 'doc_check_request_id' = r.id::text)
                and not (r.object_id is not null and exists (
                  select 1 from public.contracts c
                  where c.record_type = 'dp' and c.deleted_at is null and c.object_id = r.object_id
                    and c.created_at >= date_trunc('day', r.created_at) and to_jsonb(c) ->> 'doc_check_request_id' is null
                    and (r.counterparty_id is null or c.counterparty_id = r.counterparty_id)))),
         'у каждой живой заявки «Заключение ДП» — договор (или похожий, внесённый вручную)'
  union all
  select 7, (select relrowsecurity from pg_class where oid = 'public.contracts'::regclass),
         'contracts: RLS по-прежнему включён'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks
union all
select 'OK юрист — учётка юриста ОСП: ' || (select count(*) from public.contracts c where to_jsonb(c) ->> 'responsible_user_id' is not null)
  || ', прежний юрист снят: ' || (select count(*) from public.contracts c
       where c.responsible_contact_id is not null and to_jsonb(c) ->> 'responsible_user_id' is null)
union all
select 'OK договоров из заявок «Заключение ДП»: ' || (select count(*) from public.contracts c
  where to_jsonb(c) ->> 'doc_check_request_id' is not null);
