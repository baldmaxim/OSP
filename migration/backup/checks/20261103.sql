-- Проверка после 20261103_kp_registry_site_bids.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: представление ищется по каталогу.
with
mv as (select definition from pg_matviews where schemaname = 'public' and matviewname = 'kp_rates_registry_mv'),
v(name) as (values ('kp_rates_registry'), ('kp_rates_registry_filter_counterparties'), ('kp_rates_registry_filter_objects'),
  ('kp_rates_registry_filter_tenders'), ('kp_rates_registry_units')),
checks(n, ok, what) as (
  select 1, coalesce((select definition like '%tender_bid_rates%' and definition like '%Завершен%'
                             and definition like '%tender_counterparty_proposals%' from mv), false),
         'реестр КП: КП из файлов и цены с сайта завершённых тендеров'
  union all
  select 2, coalesce((select definition like '%proposal_id%' from mv), false)
            and exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'kp_rates_registry_mv'
                          and indexname = 'idx_kp_rates_mv_id' and indexdef like 'CREATE UNIQUE INDEX%'),
         'выбор строки при равной дате — по идентификатору; уникальный индекс для пересчёта на месте'
  union all
  select 3, (select count(*) from v join pg_views pv on pv.schemaname = 'public' and pv.viewname = v.name
             where pv.definition like '%kp_rates_registry_mv%' and pv.definition like '%osp_registry_reader()%') = 5,
         'пять представлений реестра читают его и только сотруднику'
  union all
  select 4, coalesce((select not has_table_privilege('anon', c.oid, 'select') and not has_table_privilege('authenticated', c.oid, 'select')
                      from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'kp_rates_registry_mv'), false)
            and not exists (select 1 from pg_class where relname = 'kp_rates_registry_mv_next'),
         'само представление — только служебному ключу; временного не осталось'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
