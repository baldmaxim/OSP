-- После 20261103_kp_registry_site_bids: реестр «Расценки от подрядчиков (КП)» — с ценами с сайта завершённых
-- тендеров. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
mv as (select definition from pg_matviews where schemaname = 'osp_private' and matviewname = 'kp_rates_registry_mv'),
v(name) as (values ('kp_rates_registry'), ('kp_rates_registry_filter_tenders'), ('kp_rates_registry_units')),
-- Фильтры по подрядчику и объекту — функции закрытой схемы (загрузчик, load-single-owner.sql п. 9).
fv(name) as (values ('kp_rates_registry_filter_counterparties'), ('kp_rates_registry_filter_objects')),
checks(n, ok, what) as (
  select 1, coalesce((select definition like '%tender_bid_rates%' and definition like '%Завершен%'
                             and definition like '%tender_counterparty_proposals%' and definition like '%proposal_id%' from mv), false),
         'реестр КП в закрытой схеме: КП из файлов и цены с сайта завершённых тендеров, выбор при равной дате — по идентификатору'
  union all
  select 2, exists (select 1 from pg_indexes where schemaname = 'osp_private' and tablename = 'kp_rates_registry_mv'
                      and indexname = 'idx_kp_rates_mv_id' and indexdef like 'CREATE UNIQUE INDEX%')
            and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                              where c.relname = 'kp_rates_registry_mv_next')
            and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                              where n.nspname = 'public' and c.relname = 'kp_rates_registry_mv'),
         'уникальный индекс для пересчёта на месте; временного и открытого наружу представления нет'
  union all
  select 3, (select count(*) from v join pg_views pv on pv.schemaname = 'public' and pv.viewname = v.name
             where pv.definition like '%osp_private.kp_rates_registry_mv%' and pv.definition like '%osp_registry_reader()%') = 3
            and (select count(*) from fv join pg_views pv on pv.schemaname = 'public' and pv.viewname = fv.name
                   join pg_proc p on p.proname = 'view_' || fv.name
                   join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'osp_private'
                 where pv.definition like '%osp_private.view_' || fv.name || '()%'
                   and p.prosrc like '%osp_private.kp_rates_registry_mv%' and p.prosrc like '%osp_registry_reader()%') = 2,
         'пять представлений реестра читают его (фильтры по подрядчику и объекту — через функции закрытой схемы) и только сотруднику'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
