-- Проверка после 20261120_supply_rate_delivery.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: колонки читаются только если есть (query_to_xml).
with
checks(n, ok, what) as (
  select 1, (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'tender_vor_supply_rates'
             and column_name in ('delivery_input', 'delivery_value')) = 2
            and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'tender_supply_rate_log'
             and column_name in ('delivery_input', 'delivery_value')) = 2,
         'у расценок и журнала цен — колонки доставки'
  union all
  select 2, exists (select 1 from pg_constraint where conname = 'tender_vor_supply_rates_delivery_check'),
         'доставка — за единицу или суммой и больше нуля, иначе пусто'
  union all
  select 3, coalesce(pg_get_functiondef(to_regprocedure('public.tender_vor_supply_rates_compute()')) like '%v_del_total%', false),
         'триггер расчёта складывает цену и доставку'
  union all
  select 4, coalesce(pg_get_functiondef(to_regprocedure('public.tender_supply_rate_log_write()')) like '%NEW.delivery_value%', false),
         'журнал цен пишет доставку'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
