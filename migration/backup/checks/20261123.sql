-- Проверка после 20261123_tender_compare_proposals.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: функция ищется через каталог, вызывается только если она есть.
with
fn as (
  select p.oid, p.prosecdef, p.provolatile, pg_get_function_result(p.oid) as result
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tender_compare_proposals'
    and pg_get_function_identity_arguments(p.oid) = 'p_tender uuid'
),
-- Ответ функции на тендер без КП (пустой uuid): {"coverage": …, "rows": []}.
answer as (
  select case when exists (select 1 from fn)
              then (xpath('/row/v/text()', query_to_xml(
                     'select public.tender_compare_proposals(''00000000-0000-0000-0000-000000000000'')::text as v', false, true, '')))[1]::text
         end as v
),
checks(n, ok, what) as (
  select 1, coalesce((select result = 'json' and not prosecdef and provolatile = 's' from fn), false),
         'tender_compare_proposals(uuid): json, права вызывающего (правила по строкам действуют), STABLE'
  union all
  select 2, coalesce((select has_function_privilege('authenticated', oid, 'execute')
                             and not has_function_privilege('anon', oid, 'execute') from fn), false),
         'вызывает вошедший, анониму закрыто'
  union all
  select 3, coalesce((select v::jsonb ? 'coverage' and v::jsonb -> 'rows' = '[]'::jsonb from answer), false),
         'ответ: пометка «учтено» есть / нет и строки КП (у тендера без КП — пусто)'
  union all
  select 4, (select relrowsecurity from pg_class where oid = 'public.tender_counterparty_proposals'::regclass),
         'tender_counterparty_proposals: RLS на месте'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
