-- Проверка после 20261113_doc_check_board.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: колонки читаются через каталог, данные — query_to_xml и только если они есть.
with
cols as (
  select column_name, data_type, udt_name from information_schema.columns
  where table_schema = 'public' and table_name = 'doc_check_requests'
),
-- Сколько заявок уже с исполнителями (после миграции — 0, дальше растёт).
v as (
  select case when not exists (select 1 from cols where column_name = 'assignee_ids') then null
              else (xpath('/row/n/text()', query_to_xml(
                'select count(*) as n from public.doc_check_requests where cardinality(assignee_ids) > 0', false, true, '')))[1]::text::bigint
         end as n
),
checks(n, ok, what) as (
  select 1, exists (select 1 from cols where column_name = 'assignee_ids' and udt_name = '_uuid')
        and exists (select 1 from cols where column_name = 'labels' and udt_name = '_text'),
         'doc_check_requests: assignee_ids и labels; с исполнителями: ' || coalesce((select n from v)::text, '—')
  union all
  select 2, (select count(*) = 4 from cols where column_name in ('due_date', 'priority', 'color', 'archived_at')),
         'doc_check_requests: due_date, priority, color, archived_at'
  union all
  select 3, exists (select 1 from pg_constraint where conrelid = 'public.doc_check_requests'::regclass
                      and conname = 'doc_check_requests_status_check' and pg_get_constraintdef(oid) like '%tax_clause%'),
         'статус «Проверка документов (исключение налоговой оговорки)»'
  union all
  select 4, (select relrowsecurity from pg_class where oid = 'public.doc_check_requests'::regclass),
         'doc_check_requests: RLS на месте'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
