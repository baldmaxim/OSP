-- После 20261221_drop_larix_contract_rates: прежней таблицы нет, вкладка и загрузка на месте. Строки «OK …» / «FAIL …»;
-- выполняется в транзакции миграции, с пропуском — видит все строки.
with
checks(n, ok, what) as (
  select 1, to_regclass('public.larix_contract_rates') is null,
         'прежней таблицы public.larix_contract_rates нет'
  union all
  select 2, not exists (select 1 from osp_meta.policy_roles where schema_name = 'public' and table_name = 'larix_contract_rates'),
         'записи о её правилах нет'
  union all
  select 3, to_regclass('osp_private.larix_rates') is not null and to_regclass('public.larix_rates_registry') is not null,
         'таблица и представление вкладки на месте'
  union all
  select 4, not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                        where n.nspname in ('public', 'osp_private') and p.prokind = 'f' and p.prosrc like '%larix_contract_rates%'),
         'ни одна функция её не упоминает'
  union all
  select 5, exists (select 1 from osp_private.larix_rates)
            or not exists (select 1 from public.larix_sync_runs where status = 'ok'),
         'была удачная загрузка — в новой таблице есть строки'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
