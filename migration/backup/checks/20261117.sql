-- Проверка после 20261117_dc_request_submission_responsible.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: колонки читаются только через каталог и query_to_xml, если они есть.
with
cols as (
  select column_name, data_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'dc_requests' and column_name like 'submission\_resp\_%'
),
-- Заявки с ФИО ответственного без самого ответственного (до миграции колонок нет — не считаем).
orphan as (
  select case when (select count(*) from cols) < 2 then null
              else (xpath('/row/n/text()', query_to_xml(
                     'select count(*) as n from public.dc_requests
                      where submission_resp_user_id is null and submission_resp_name is not null',
                     false, true, '')))[1]::text::bigint end as n
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
  select 3, coalesce((select n from orphan) = 0, false),
         'заявок с ФИО ответственного без самого ответственного нет'
  union all
  select 4, (select relrowsecurity from pg_class where oid = 'public.dc_requests'::regclass),
         'dc_requests: RLS включён'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
