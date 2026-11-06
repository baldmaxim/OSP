-- Проверка после 20270104_dc_request_amounts_vor.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor сразу после миграции; до миграции
-- отвечает FAIL, а не ошибкой (новые колонки читаются через to_jsonb). Пункты 2–3 верны сразу после переноса:
-- позже суммы в верхней части «ДС по тендеру» может внести и человек.
with
cols(name) as (values ('amount_contractor'), ('vor_amount_before'), ('vor_amount_after')),
col_ok as (
  select c.name, exists (select 1 from information_schema.columns i
                         where i.table_schema = 'public' and i.table_name = 'dc_requests' and i.column_name = c.name
                           and i.data_type = 'numeric' and i.numeric_precision = 14 and i.numeric_scale = 2
                           and i.is_nullable = 'YES') as ok
  from cols c
),
checks(n, ok, what) as (
  select 1, (select bool_and(ok) from col_ok),
         'dc_requests: amount_contractor, vor_amount_before, vor_amount_after — numeric(14,2), можно пусто'
  union all
  select 2, not exists (select 1 from public.dc_requests r
                        where r.ds_type = 'tender_ds' and (r.amount_before is not null or r.amount_after is not null)
                          and to_jsonb(r) ->> 'vor_amount_before' is null and to_jsonb(r) ->> 'vor_amount_after' is null),
         '«ДС по тендеру»: суммы перенесены в «Было ВОР подрядчик» / «Стало ВОР ОСП»'
  union all
  select 3, not exists (select 1 from public.dc_requests r
                        where r.ds_type = 'tender_ds'
                          and (to_jsonb(r) ->> 'vor_amount_before' is not null or to_jsonb(r) ->> 'vor_amount_after' is not null)
                          and not exists (select 1 from public.dc_request_audit_log l
                                          where l.dc_request_id = r.id and l.description like '%(миграция 20270104)')),
         'у каждой перенесённой заявки — запись в истории'
  union all
  select 4, (select relrowsecurity from pg_class where oid = 'public.dc_requests'::regclass),
         'dc_requests: RLS включён'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
