-- Проверка после 20270225_dp_conclusion_registry_contract.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции; до миграции отвечает FAIL, а не падает.
-- Последние строки — числа для отчёта: сколько договоров создано из заявок и сколько заявок «В работе» пропущено (похожий договор).
with
col as (
  select data_type, is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 'contracts' and column_name = 'doc_check_request_id'
),
fk as (
  select pg_get_constraintdef(oid) as def from pg_constraint
  where conrelid = 'public.contracts'::regclass and conname = 'contracts_doc_check_request_id_fkey' and contype = 'f'
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where data_type = 'uuid' and is_nullable = 'YES'),
         'contracts.doc_check_request_id: uuid, может быть пустым'
  union all
  select 2, coalesce((select def like '%REFERENCES doc_check_requests(id)%' and def like '%ON DELETE SET NULL%' from fk), false),
         'ссылка — на заявку доски, при её удалении пустеет'
  union all
  select 3, exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'contracts'
                      and indexname = 'contracts_doc_check_request_uniq'),
         'одна заявка — не больше одного договора'
  union all
  select 4, (select count(*) = 2 from pg_trigger where tgrelid = 'public.doc_check_requests'::regclass and not tgisinternal
               and tgname in ('doc_check_dp_conclusion_contract', 'doc_check_assign_alert')),
         'триггеры доски: договор при входе в работу и окно исполнителю'
  union all
  select 5, to_regclass('public.doc_check_assign_alerts') is not null
            and coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.doc_check_assign_alerts')), false),
         'doc_check_assign_alerts: есть, RLS включён'
  union all
  select 6, to_regprocedure('public.doc_check_assign_my_alerts()') is not null
            and to_regprocedure('public.doc_check_assign_alerts_ack(uuid[])') is not null,
         'функции окна исполнителя: мои уведомления и «прочитано»'
  union all
  select 7, (select relrowsecurity from pg_class where oid = 'public.contracts'::regclass),
         'contracts: RLS по-прежнему включён'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks
union all
select 'OK договоров из заявок «Заключение ДП»: ' || (select count(*) from public.contracts c
  where to_jsonb(c) ->> 'doc_check_request_id' is not null)
union all
select 'OK заявок «Заключение ДП» в работе без договора: ' || (select count(*) from public.doc_check_requests r
  where r.doc_type = 'dp_conclusion' and r.deleted_at is null and r.status = 'in_progress'
    and not exists (select 1 from public.contracts c where to_jsonb(c) ->> 'doc_check_request_id' = r.id::text));
