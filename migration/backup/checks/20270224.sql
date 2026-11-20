-- Проверка после 20270224_supply_registry_import.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: таблицы, представления и функция ищутся по каталогу.
with
tbl as (select c.relname, c.oid, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('supply_registry_imports', 'supply_registry_rates') and c.relkind = 'r'),
v(name) as (values ('supply_rates_registry'), ('supply_rates_registry_filter_objects'), ('supply_rates_registry_filter_tenders'),
  ('supply_rates_registry_units')),
fn as (select p.oid, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'supply_registry_import'),
checks(n, ok, what) as (
  select 1, (select count(*) from tbl where relrowsecurity) = 2
            and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'supply_registry_imports'
                   and policyname in ('supply_registry_imports_read', 'supply_registry_imports_insert', 'supply_registry_imports_delete')) = 3
            and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'supply_registry_rates'
                   and policyname in ('supply_registry_rates_read', 'supply_registry_rates_insert')) = 2
            and exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'supply_registry_rates'
                          and indexname = 'supply_registry_rates_uniq' and indexdef like 'CREATE UNIQUE INDEX%'),
         'загрузки расценок и их строки: правила по строкам (читает реестр, пишет право правки реестра), одна расценка — один раз'
  union all
  select 2, coalesce((select bool_and(not has_table_privilege('anon', oid, 'select') and not has_table_privilege('anon', oid, 'insert')
                                      and has_table_privilege('authenticated', oid, 'select')
                                      and not has_table_privilege('authenticated', oid, 'update'))
                      from tbl having count(*) = 2), false),
         'загрузки расценок: анониму ничего, вошедшему — через правила по строкам, без правки строк'
  union all
  select 3, (select count(*) from v join pg_views pv on pv.schemaname = 'public' and pv.viewname = v.name
             where pv.definition like '%supply_rates_registry_mv%' and pv.definition like '%supply_registry_rates%'
               and pv.definition like '%osp_registry_reader()%') = 4
            and (select string_agg(column_name::text, ',' order by ordinal_position) from information_schema.columns
                 where table_schema = 'public' and table_name = 'supply_rates_registry')
                = 'id,source_type,source_name,item_name,unit,price,tender_id,object_id,tender_desc,object_name,rate_date,import_id',
         'четыре представления реестра СУ-10 — с загруженными строками и только читателю реестра; колонки — прежние и import_id'
  union all
  select 4, coalesce((select not prosecdef and not has_function_privilege('anon', oid, 'execute')
                             and has_function_privilege('authenticated', oid, 'execute') from fn), false),
         'загрузка порцией: с правами вызывающего, вошедшему (пишет по праву реестра), анониму — нет'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
