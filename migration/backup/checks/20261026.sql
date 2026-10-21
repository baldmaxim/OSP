-- Проверка после 20261026_counterparty_vat.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: новые колонки читаются через query_to_xml и только если они есть.
with
col as (
  select column_name, data_type, is_nullable, column_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'counterparties' and column_name in ('vat_rate', 'vat_exempt')
),
con as (
  select pg_get_constraintdef(c.oid) as def from pg_constraint c
  where c.conrelid = 'public.counterparties'::regclass and c.conname = 'counterparties_vat_check'
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where column_name = 'vat_rate' and data_type = 'numeric')
            and exists (select 1 from col where column_name = 'vat_exempt' and data_type = 'boolean'
                        and is_nullable = 'NO' and column_default = 'false'),
         'counterparties.vat_rate (numeric) и vat_exempt (boolean, NOT NULL, по умолчанию false)'
  union all
  select 2, exists (select 1 from con where def ilike '%vat_exempt%vat_rate%' and def ilike '%100%'),
         'counterparties: ставка 0…100 %, ставка и «без НДС» одновременно запрещены (counterparties_vat_check)'
  union all
  select 3, case when (select count(*) from col) < 2 then false
                 else (xpath('/row/n/text()', query_to_xml(
                   'select count(*) as n from public.counterparties where vat_rate is not null or vat_exempt',
                   false, true, '')))[1]::text = '0' end,
         'counterparties: НДС ни у кого не указан — данные не изменились'
  union all
  select 4, (select relrowsecurity from pg_class where oid = 'public.counterparties'::regclass),
         'counterparties: RLS по-прежнему включён'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
