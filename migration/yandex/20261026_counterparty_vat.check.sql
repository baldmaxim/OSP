-- После 20261026_counterparty_vat: у counterparties есть vat_rate / vat_exempt и ограничение «ставка 0…100 %, ставка и
-- без НДС одновременно нельзя»; данные не тронуты, правила по строкам на месте.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
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
  select 3, not exists (select 1 from public.counterparties where vat_rate is not null or vat_exempt),
         'counterparties: НДС ни у кого не указан — данные не изменились'
  union all
  select 4, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.counterparties'::regclass),
         'counterparties: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
