-- Проверка после 20270228_doc_check_registry_docs.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции; до миграции отвечает FAIL, а не падает
-- (связь договора с заявкой — через to_jsonb: колонки нет, пока не применена 20270225).
-- Последняя строка — числа для отчёта: сколько документов из «Проверок ДП/ДС», сколько не внесено, сколько помечено.
with
fns as (
  select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg from pg_proc p
  where p.oid in (to_regprocedure('public.doc_check_registry_note(uuid, text, jsonb, text)'),
                  to_regprocedure('public.doc_check_registry_doc_create(uuid, text)'),
                  to_regprocedure('public.doc_check_dp_conclusion_contract()'))
),
pure as (
  select p.proname from pg_proc p
  where p.oid in (to_regprocedure('public.doc_check_number_clean(text)'), to_regprocedure('public.doc_check_number_key(text)'),
                  to_regprocedure('public.doc_check_number_spaced(text)'), to_regprocedure('public.doc_check_number_contains(text, text)'),
                  to_regprocedure('public.doc_check_type_title(text)'))
    and not p.prosecdef and p.provolatile = 'i'
),
waiting as (
  select r.id, r.doc_type from public.doc_check_requests r
  where r.doc_type in ('dp', 'ds') and r.status = 'new' and r.deleted_at is null
),
checks(n, ok, what) as (
  select 1, (select count(*) = 3 and bool_and(prosecdef and cfg like '%application_name=osp:internal%') from fns),
         'три служебные функции с отметкой osp:internal: запись в «Историю», документ из заявки, триггер доски'
  union all
  select 2, (select count(*) = 5 from pure), 'номер без невидимых знаков, ключ и сравнение номеров, вид заявки словами — чистые функции'
  union all
  select 3, exists (select 1 from pg_trigger where tgrelid = 'public.doc_check_requests'::regclass and not tgisinternal
                      and tgname = 'doc_check_dp_conclusion_contract' and tgenabled = 'O'
                      and pg_get_triggerdef(oid) like '%doc_number%' and pg_get_triggerdef(oid) like '%''ds''%'),
         'триггер доски: все три вида заявки, правка объекта, контрагента и номера'
  union all
  select 4, not exists (select 1 from waiting w
                        where not exists (select 1 from public.contracts c where to_jsonb(c) ->> 'doc_check_request_id' = w.id::text)
                          and not exists (select 1 from public.doc_check_request_audit_log l
                                          where l.request_id = w.id and l.event_type = 'registry_skipped')
                          and not exists (select 1 from public.doc_check_requests r
                                          where r.id = w.id and r.notes like '%Вероятно, ошибочное создание%')),
         'каждая «Проверка ДП/ДС» в «Новых» — в реестре, или в её «Истории» записано, почему нет'
  union all
  select 5, not exists (select 1 from public.contracts c join public.doc_check_requests r on r.id::text = to_jsonb(c) ->> 'doc_check_request_id'
                        where (r.doc_type = 'ds' and (c.record_type <> 'ds_extra' or c.parent_contract_id is null))
                           or (r.doc_type in ('dp', 'dp_conclusion') and c.deleted_at is null and c.record_type <> 'dp')),
         'вид документа — как у заявки: «Проверка ДС» — ДС на доп. работы к договору, остальные — договор'
  union all
  select 6, not exists (select 1 from public.contracts c join public.doc_check_requests r on r.id::text = to_jsonb(c) ->> 'doc_check_request_id'
                        where c.created_at >= now() - interval '1 minute'
                          and c.status <> case when r.status = 'new' then 'new_request' else 'in_work' end),
         'новые документы из заявок: «Новые» — «Новая заявка», остальные колонки — «В работе»'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks
union all
select 'OK документов из «Проверок ДП/ДС»: ' || (select count(*) from public.contracts c join public.doc_check_requests r
                                                  on r.id::text = to_jsonb(c) ->> 'doc_check_request_id' where r.doc_type in ('dp', 'ds'))
  || ', не внесено (причина в «Истории»): ' || (select count(distinct l.request_id) from public.doc_check_request_audit_log l
                                                 join waiting w on w.id = l.request_id where l.event_type = 'registry_skipped'
                                                   and not exists (select 1 from public.contracts c where to_jsonb(c) ->> 'doc_check_request_id' = w.id::text))
  || ', помечено «вероятно ошибочное создание»: ' || (select count(*) from public.doc_check_requests r
                                                     where r.notes like '%Вероятно, ошибочное создание%');
