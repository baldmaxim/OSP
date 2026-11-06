-- Проверка после 20261230_dc_request_notes.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции; до миграции отвечает FAIL.
with
checks(n, ok, what) as (
  select 1, exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'dc_requests'
                      and column_name = 'notes' and data_type = 'text' and is_nullable = 'YES'),
         'dc_requests.notes: text, можно пусто'
  union all
  select 2, exists (select 1 from pg_constraint where conrelid = 'public.dc_requests'::regclass
                      and conname = 'dc_requests_notes_check' and pg_get_constraintdef(oid) like '%5000%'),
         'примечание — не длиннее 5000 знаков'
  union all
  select 3, (select relrowsecurity from pg_class where oid = 'public.dc_requests'::regclass),
         'dc_requests: RLS включён'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
