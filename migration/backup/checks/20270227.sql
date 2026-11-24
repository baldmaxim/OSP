-- Проверка после 20270227_supply_registry_rate_details.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: колонки, индексы и представление ищутся по каталогу.
with
tbl as (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'supply_registry_rates' and c.relkind = 'r'),
fn as (select p.oid, p.prosecdef, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'supply_registry_import'),
checks(n, ok, what) as (
  select 1, (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'supply_registry_rates'
             and column_name in ('contractor_label', 'doc_number', 'order_number', 'source_file', 'invoice_url')) = 5
            and exists (select 1 from pg_constraint where conrelid = (select oid from tbl) and conname = 'supply_registry_rates_invoice_url'),
         'у загруженной расценки — подрядчик по папке, № документа, № заявки / заказа, файл-источник, ссылка на счёт (только http/https)'
  union all
  select 2, (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'supply_registry_rates'
             and indexname in ('supply_registry_rates_name_idx', 'supply_registry_rates_name_trgm')) = 2,
         'поиск и порядок по наименованию загруженных строк — по индексу'
  union all
  select 3, (select string_agg(column_name::text, ',' order by ordinal_position) from information_schema.columns
             where table_schema = 'public' and table_name = 'supply_rates_registry')
            = 'id,source_type,source_name,item_name,unit,price,tender_id,object_id,tender_desc,object_name,rate_date,import_id,'
              'contractor_label,doc_number,order_number,source_file,invoice_url,object_label,tender_label,row_no'
            and exists (select 1 from pg_views where schemaname = 'public' and viewname = 'supply_rates_registry'
                          and definition like '%osp_registry_reader()%'),
         'реестр СУ-10: прежние колонки на своих местах, подробности — в конце; только читателю реестра'
  union all
  select 4, coalesce((select not prosecdef and prosrc like '%invoice_url%' and prosrc like '%osp_can(''rates_registry'', ''edit'')%'
                             and not has_function_privilege('anon', oid, 'execute')
                             and has_function_privilege('authenticated', oid, 'execute') from fn), false)
            and coalesce((select not has_table_privilege('anon', c.oid, 'select') and has_table_privilege('authenticated', c.oid, 'select')
                          from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname = 'public' and c.relname = 'supply_rates_registry'), false),
         'загрузка порцией — с правами вызывающего и новыми полями; анониму ни загрузки, ни реестра'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
