-- После 20270224_supply_registry_import: загрузка расценок из Excel в реестр «Расценки от снабжения СУ-10». Строки
-- «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
tbl as (select c.relname, c.oid, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('supply_registry_imports', 'supply_registry_rates') and c.relkind = 'r'),
v(name) as (values ('supply_rates_registry'), ('supply_rates_registry_filter_objects'), ('supply_rates_registry_filter_tenders'),
  ('supply_rates_registry_units')),
checks(n, ok, what) as (
  select 1, (select count(*) from tbl where relrowsecurity and relforcerowsecurity) = 2
            and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'supply_registry_imports'
                   and policyname in ('osp_internal', 'supply_registry_imports_read', 'supply_registry_imports_insert',
                                      'supply_registry_imports_delete')) = 4
            and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'supply_registry_rates'
                   and policyname in ('osp_internal', 'supply_registry_rates_read', 'supply_registry_rates_insert')) = 3
            and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'supply_registry_rates'
                              and cmd in ('UPDATE', 'DELETE') and policyname <> 'osp_internal')
            and (select count(*) from osp_meta.policy_roles where table_name in ('supply_registry_imports', 'supply_registry_rates')) = 5,
         'загрузки и их строки: правила по строкам действуют и на владельца, пропуск служебных операций; строки не правятся'
  union all
  select 2, exists (select 1 from pg_trigger where tgname = 'supply_registry_imports_stamp'
                      and tgrelid = (select oid from tbl where relname = 'supply_registry_imports'))
            and exists (select 1 from pg_trigger where tgname = 'supply_registry_rates_stamp'
                          and tgrelid = (select oid from tbl where relname = 'supply_registry_rates'))
            and exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'supply_registry_rates'
                          and indexname = 'supply_registry_rates_uniq' and indexdef like 'CREATE UNIQUE INDEX%')
            and exists (select 1 from pg_constraint where conrelid = (select oid from tbl where relname = 'supply_registry_rates')
                          and contype = 'f' and confdeltype = 'c'),
         'кто и когда — триггером; одна расценка — один раз (уникальный индекс); строки удаляются с загрузкой'
  union all
  select 3, (select count(*) from v join pg_views pv on pv.schemaname = 'public' and pv.viewname = v.name
             where pv.definition like '%osp_private.supply_rates_registry_mv%'
               and pv.definition like '%osp_private.view_supply_registry_rates()%'
               and pv.definition like '%osp_registry_reader()%') = 4
            and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'osp_private' and p.proname = 'view_supply_registry_rates'
                          and coalesce(p.proconfig::text, '') ~ 'application_name=osp:internal'
                          and p.prosrc like '%osp_registry_reader()%'),
         'представления реестра СУ-10 — с загруженными строками (через закрытую схему) и только читателю реестра'
  union all
  select 4, (select string_agg(column_name::text, ',' order by ordinal_position) from information_schema.columns
             where table_schema = 'public' and table_name = 'supply_rates_registry')
            = 'id,source_type,source_name,item_name,unit,price,tender_id,object_id,tender_desc,object_name,rate_date,import_id',
         'у реестра прежние колонки на своих местах, import_id — в конце'
  union all
  select 5, exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'supply_registry_import' and not p.prosecdef),
         'загрузка порцией — с правами вызывающего'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
