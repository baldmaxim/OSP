-- После 20270104_dc_request_amounts_vor: у заявок на ДС — «ДС подрядчика» и суммы ВОР; суммы «ДС по тендеру»
-- перенесены в нижнюю часть, у каждой перенесённой — запись в истории; правила по строкам на месте.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
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
  select 4, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.dc_requests'::regclass),
         'dc_requests: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
