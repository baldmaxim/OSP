-- Проверка после 20261122_kp_registry_manual_sources.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: таблица, представления и функция ищутся по каталогу.
with
mv as (select definition from pg_matviews where schemaname = 'public' and matviewname = 'kp_rates_registry_mv'),
tbl as (select c.oid, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'kp_manual_rates' and c.relkind = 'r'),
v(name) as (values ('kp_rates_registry'), ('kp_rates_registry_filter_counterparties'), ('kp_rates_registry_filter_objects'),
  ('kp_rates_registry_filter_tenders'), ('kp_rates_registry_units')),
fn as (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'kp_rates_lookup'),
checks(n, ok, what) as (
  select 1, coalesce((select relrowsecurity from tbl), false)
            and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'kp_manual_rates'
                   and policyname in ('kp_manual_rates_read', 'kp_manual_rates_insert', 'kp_manual_rates_update', 'kp_manual_rates_delete')) = 4
            and exists (select 1 from pg_trigger where tgname = 'kp_manual_rates_stamp' and tgrelid = (select oid from tbl)),
         'ручные расценки: таблица с правилами по строкам (читает реестр, пишет право правки реестра), кто и когда — триггером'
  union all
  select 2, coalesce((select not has_table_privilege('anon', oid, 'select') and not has_table_privilege('anon', oid, 'insert')
                             and has_table_privilege('authenticated', oid, 'select') and has_table_privilege('authenticated', oid, 'insert')
                      from tbl), false),
         'ручные расценки: анониму ничего, вошедшему — через правила по строкам'
  union all
  select 3, coalesce((select definition like '%tender_proposal_files%' and definition like '%estimate_name%'
                             and definition like '%tender_bid_rates%' and definition like '%source_doc_id%' from mv), false)
            and exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'kp_rates_registry_mv'
                          and indexname = 'idx_kp_rates_mv_id' and indexdef like 'CREATE UNIQUE INDEX%')
            and not exists (select 1 from pg_class where relname = 'kp_rates_registry_mv_next'),
         'реестр КП: ВОР и файл КП у строк, цены с сайта; уникальный индекс для пересчёта на месте; временного не осталось'
  union all
  select 4, (select count(*) from v join pg_views pv on pv.schemaname = 'public' and pv.viewname = v.name
             where pv.definition like '%kp_rates_registry_mv%' and pv.definition like '%kp_manual_rates%'
               and pv.definition like '%osp_registry_reader()%') = 5
            and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'kp_rates_registry'
                   and column_name in ('source_kind', 'estimate_name', 'source_doc_id', 'source_doc_name', 'source_url', 'manual_id', 'note')) = 7,
         'пять представлений реестра — с ручными расценками и только читателю реестра; у реестра колонки источника'
  union all
  select 5, coalesce((select not has_table_privilege('anon', c.oid, 'select') and not has_table_privilege('authenticated', c.oid, 'select')
                      from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'kp_rates_registry_mv'), false),
         'само материализованное представление — только служебному ключу'
  union all
  select 6, coalesce((select not has_function_privilege('anon', oid, 'execute') and has_function_privilege('authenticated', oid, 'execute')
                      from fn), false),
         'поиск похожих расценок для проверки файла: вошедшему (строки — по праву реестра), анониму — нет'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
