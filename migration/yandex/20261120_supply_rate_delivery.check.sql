-- После 20261120_supply_rate_delivery: доставка позиции в расценке снабжением. Строки «OK …» / «FAIL …»; выполняется
-- в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
checks(n, ok, what) as (
  select 1, (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'tender_vor_supply_rates'
             and column_name in ('delivery_input', 'delivery_value')) = 2
            and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'tender_supply_rate_log'
             and column_name in ('delivery_input', 'delivery_value')) = 2,
         'у расценок и журнала цен — колонки доставки (как ввели и значение)'
  union all
  select 2, exists (select 1 from pg_constraint where conname = 'tender_vor_supply_rates_delivery_check'
                    and conrelid = 'public.tender_vor_supply_rates'::regclass),
         'доставка — за единицу или суммой и больше нуля, иначе пусто (ограничение)'
  union all
  select 3, pg_get_functiondef('public.tender_vor_supply_rates_compute()'::regprocedure) like '%v_del_total%'
            and pg_get_functiondef('public.tender_vor_supply_rates_compute()'::regprocedure) like '%Europe/Moscow%',
         'триггер расчёта складывает цену и доставку; день расценки — как раньше'
  union all
  select 4, pg_get_functiondef('public.tender_supply_rate_log_write()'::regprocedure) like '%NEW.delivery_value%',
         'журнал цен пишет доставку'
  union all
  select 5, not exists (select 1 from public.tender_vor_supply_rates where delivery_input is not null or delivery_value is not null),
         'существующие цены без доставки и не пересчитаны'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
