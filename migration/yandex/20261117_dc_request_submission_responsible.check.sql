-- После 20261117_dc_request_submission_responsible: у заявки на ДС — ответственный за статус ОКС (id и ФИО), без
-- ответственного ФИО нет; правила по строкам на месте.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
cols as (
  select column_name, data_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'dc_requests' and column_name like 'submission\_resp\_%'
),
checks(n, ok, what) as (
  select 1, (select count(*) from cols where (column_name, data_type) in (('submission_resp_user_id', 'uuid'),
              ('submission_resp_name', 'text'))) = 2,
         'dc_requests: ответственный за статус ОКС (submission_resp_user_id uuid, submission_resp_name text)'
  union all
  select 2, exists (select 1 from pg_constraint where conrelid = 'public.dc_requests'::regclass and contype = 'c'
                      and conname = 'dc_requests_submission_resp_check'),
         'ограничение: ФИО — только при ответственном, до 300 символов'
  union all
  select 3, not exists (select 1 from public.dc_requests where submission_resp_user_id is null and submission_resp_name is not null),
         'заявок с ФИО ответственного без самого ответственного нет'
  union all
  select 4, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.dc_requests'::regclass),
         'dc_requests: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
