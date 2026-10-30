-- После 20261122_kp_registry_manual_sources: ручные расценки в реестре КП, документ-источник, поиск похожих для
-- проверки файла. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
mv as (select definition from pg_matviews where schemaname = 'osp_private' and matviewname = 'kp_rates_registry_mv'),
tbl as (select c.oid, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'kp_manual_rates' and c.relkind = 'r'),
v(name) as (values ('kp_rates_registry'), ('kp_rates_registry_filter_tenders'), ('kp_rates_registry_units')),
fv(name) as (values ('view_kp_rates_registry_filter_counterparties'), ('view_kp_rates_registry_filter_objects')),
checks(n, ok, what) as (
  select 1, coalesce((select relrowsecurity and relforcerowsecurity from tbl), false)
            and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'kp_manual_rates'
                   and policyname in ('osp_internal', 'kp_manual_rates_read', 'kp_manual_rates_insert', 'kp_manual_rates_update',
                                      'kp_manual_rates_delete')) = 5
            and (select count(*) from osp_meta.policy_roles where table_name = 'kp_manual_rates') = 4
            and exists (select 1 from pg_trigger where tgname = 'kp_manual_rates_stamp' and tgrelid = (select oid from tbl)),
         'ручные расценки: правила по строкам действуют и на владельца, пропуск служебных операций, кто и когда — триггером'
  union all
  select 2, coalesce((select definition like '%tender_proposal_files%' and definition like '%estimate_name%'
                             and definition like '%tender_bid_rates%' and definition like '%source_doc_id%' from mv), false)
            and exists (select 1 from pg_indexes where schemaname = 'osp_private' and tablename = 'kp_rates_registry_mv'
                          and indexname = 'idx_kp_rates_mv_id' and indexdef like 'CREATE UNIQUE INDEX%')
            and not exists (select 1 from pg_class where relname = 'kp_rates_registry_mv_next'),
         'реестр КП в закрытой схеме: ВОР и файл КП у строк, цены с сайта; уникальный индекс; временного не осталось'
  union all
  select 3, (select count(*) from v join pg_views pv on pv.schemaname = 'public' and pv.viewname = v.name
             where pv.definition like '%osp_private.kp_rates_registry_mv%' and pv.definition like '%osp_private.view_kp_manual_rates()%'
               and pv.definition like '%osp_registry_reader()%') = 3
            and (select count(*) from fv join pg_proc p on p.proname = fv.name
                   join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'osp_private'
                 where p.prosrc like '%osp_private.kp_rates_registry_mv%' and p.prosrc like '%kp_manual_rates%'
                   and p.prosrc like '%osp_registry_reader()%') = 2
            and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'osp_private' and p.proname = 'view_kp_manual_rates'
                          and coalesce(p.proconfig::text, '') ~ 'application_name=osp:internal'),
         'представления и фильтры реестра — с ручными расценками (через закрытую схему) и только читателю реестра'
  union all
  select 4, (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'kp_rates_registry'
               and column_name in ('source_kind', 'estimate_name', 'source_doc_id', 'source_doc_name', 'source_url', 'manual_id', 'note')) = 7,
         'у реестра — колонки источника (прежние на своих местах)'
  union all
  select 5, exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'kp_rates_lookup' and not p.prosecdef),
         'поиск похожих расценок для проверки файла — с правами вызывающего'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
