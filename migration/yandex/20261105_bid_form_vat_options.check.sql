-- После 20261105_bid_form_vat_options: в выборе ставки НДС анкеты нет прежнего длинного списка.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh).
with checks(n, ok, what) as (
  select 1,
    not exists (
      select 1 from public.bid_form_fields
      where code = 'vat'
        and options = '["22 %", "20 %", "10 %", "7 %", "5 %", "0 %", "Без НДС"]'::jsonb
    ),
    'в выборе ставки НДС анкеты нет прежнего списка'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
