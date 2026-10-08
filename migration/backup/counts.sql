-- Точное число строк в каждой таблице схемы public.
--
-- Только чтение: один SELECT. В ответе только имена таблиц и числа — никаких данных.
-- Используют backup.sh (до и после копии), verify.sh и rehearse.sh (на копии),
-- counts.sh (прод после миграции). Можно запустить и в Supabase SQL Editor.
-- query_to_xml выполняет count(*) по каждой таблице внутри одного SELECT.
select c.relname as table_name,
       (xpath('/row/n/text()',
              query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')
       ))[1]::text::bigint as rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and not c.relispartition
order by c.relname;
