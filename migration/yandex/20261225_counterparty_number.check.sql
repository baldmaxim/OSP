-- После 20261225_counterparty_number: у каждого контрагента постоянный номер, отметка времени не тронута, функция отдаёт
-- только id и число. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
col as (
  select data_type, is_nullable, is_identity, identity_generation
  from information_schema.columns
  where table_schema = 'public' and table_name = 'counterparties' and column_name = 'counterparty_number'
),
v as (
  select count(*) as total, count(distinct counterparty_number) as uniq,
         coalesce(min(counterparty_number), 1) as lo, coalesce(max(counterparty_number), 0) as hi
  from public.counterparties
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where data_type = 'integer' and is_nullable = 'NO'
                      and is_identity = 'YES' and identity_generation = 'ALWAYS'),
         'counterparties.counterparty_number: integer, NOT NULL, GENERATED ALWAYS AS IDENTITY'
  union all
  select 2, exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                    where i.indrelid = 'public.counterparties'::regclass and i.indisunique and i.indnatts = 1
                      and a.attname = 'counterparty_number'),
         'номер уникален (counterparties_number_key)'
  union all
  select 3, (select total = uniq and lo = 1 and hi = total from v),
         'номер есть у каждого контрагента, без повторов и пропусков, с 1'
  union all
  select 4, not exists (select 1 from pg_trigger where tgrelid = 'public.counterparties'::regclass
                          and tgname = 'trigger_update_counterparties_updated_at' and tgenabled <> 'O'),
         'триггер отметки времени снова включён'
  union all
  select 5, (select prosecdef and proconfig @> array['application_name=osp:internal']
             from pg_proc where oid = 'public.counterparty_site_accounts()'::regprocedure),
         'counterparty_site_accounts: служебная функция с отметкой'
  union all
  select 6, (select pg_get_function_result('public.counterparty_site_accounts()'::regprocedure) = 'TABLE(counterparty_id uuid, accounts integer)'),
         'counterparty_site_accounts отдаёт только id организации и число'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
