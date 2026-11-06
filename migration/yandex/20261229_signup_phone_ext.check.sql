-- После 20261229_signup_phone_ext: заявка принимает номер с добавочным, остальное условие — прежнее.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
rule(src) as (
  select pg_get_constraintdef(oid) from pg_constraint
  where conrelid = 'osp_auth.registrations'::regclass and conname = 'registrations_phone_check'
),
checks(n, ok, what) as (
  select 1, (select count(*) = 1 from rule), 'registrations_phone_check есть'
  union all
  select 2, (select src like '%доб%' from rule), 'registrations_phone_check: условие с добавочным номером'
  union all
  select 3, ('+79161234567 доб. 123456' ~ '^\+[0-9]{8,15}( доб\. [0-9]{1,6})?$'
             and '+79161234567' ~ '^\+[0-9]{8,15}( доб\. [0-9]{1,6})?$'
             and '+79161234567 доб. 1234567' !~ '^\+[0-9]{8,15}( доб\. [0-9]{1,6})?$'
             and '+7916 доб. 1' !~ '^\+[0-9]{8,15}( доб\. [0-9]{1,6})?$'),
         'образец условия: добавочный до 6 цифр, номер как раньше'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
