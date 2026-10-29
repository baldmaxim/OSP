-- Проверка после 20261114_counterparty_status_limited.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: значения ENUM читаются из каталога, число контрагентов «Малые суммы» —
-- query_to_xml и только если значение уже есть (иначе сравнение с 'limited' падало бы ошибкой 22P02).
with
labels as (
  select e.enumlabel, e.enumsortorder from pg_enum e
  join pg_type t on t.oid = e.enumtypid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typname = 'counterparty_status'
),
v as (
  select case when not exists (select 1 from labels where enumlabel = 'limited') then null
              else (xpath('/row/n/text()', query_to_xml(
                'select count(*) as n from public.counterparties where status::text = ''limited''', false, true, '')))[1]::text::bigint
         end as n
),
checks(n, ok, what) as (
  select 1, exists (select 1 from labels where enumlabel = 'limited'),
         'counterparty_status: есть limited («Малые суммы»); контрагентов с ним: ' || coalesce((select n from v)::text, '—')
  union all
  select 2, (select array_agg(enumlabel order by enumsortorder) from labels) = array['active', 'limited', 'blacklist']::name[],
         'counterparty_status: порядок active, limited, blacklist'
  union all
  select 3, (select relrowsecurity from pg_class where oid = 'public.counterparties'::regclass),
         'counterparties: RLS на месте'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
