-- После 20261114_counterparty_status_limited: у статуса контрагента есть «Малые суммы» (limited); правила по строкам на месте.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
labels as (
  select e.enumlabel, e.enumsortorder from pg_enum e
  join pg_type t on t.oid = e.enumtypid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typname = 'counterparty_status'
),
checks(n, ok, what) as (
  select 1, exists (select 1 from labels where enumlabel = 'limited'), 'counterparty_status: есть limited («Малые суммы»)'
  union all
  select 2, (select array_agg(enumlabel order by enumsortorder) from labels) = array['active', 'limited', 'blacklist']::name[],
         'counterparty_status: порядок active, limited, blacklist'
  union all
  select 3, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.counterparties'::regclass),
         'counterparties: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
