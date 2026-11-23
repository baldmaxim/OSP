-- После 20270227_supply_registry_rate_details: строки загрузок реестра СУ-10 — в закрытой схеме, поиск по индексу,
-- подробности расценки и ссылка на счёт. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с
-- отметкой служебной операции.
with
tbl as (select c.oid, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'osp_private' and c.relname = 'supply_registry_rates' and c.relkind = 'r'),
v(name) as (values ('supply_rates_registry'), ('supply_rates_registry_filter_objects'), ('supply_rates_registry_filter_tenders'),
  ('supply_rates_registry_units')),
checks(n, ok, what) as (
  select 1, (select count(*) from tbl where not relrowsecurity) = 1
            and to_regclass('public.supply_registry_rates') is null
            and to_regprocedure('osp_private.view_supply_registry_rates()') is null
            and not exists (select 1 from osp_meta.policy_roles where schema_name = 'public' and table_name = 'supply_registry_rates'),
         'строки загрузок — в закрытой схеме (без правил, PostgREST не видит); прежняя таблица и чтение через функцию убраны'
  union all
  select 2, (select count(*) from pg_indexes where schemaname = 'osp_private' and tablename = 'supply_registry_rates'
             and indexname in ('supply_registry_rates_reg_id', 'supply_registry_rates_name_idx', 'supply_registry_rates_name_trgm',
                               'supply_registry_rates_date_idx', 'supply_registry_rates_uniq')) = 5
            and exists (select 1 from pg_indexes where schemaname = 'osp_private' and tablename = 'supply_registry_rates'
                          and indexname = 'supply_registry_rates_uniq' and indexdef like 'CREATE UNIQUE INDEX%')
            and exists (select 1 from pg_constraint where conrelid = (select oid from tbl) and contype = 'f' and confdeltype = 'c'
                          and confrelid = 'public.supply_registry_imports'::regclass)
            and exists (select 1 from pg_trigger where tgname = 'supply_registry_rates_stamp' and tgrelid = (select oid from tbl)),
         'поиск и порядок по наименованию — по индексу; одна расценка — один раз; строки удаляются с загрузкой; очистка полей — триггером'
  union all
  select 3, (select count(*) from v join pg_views pv on pv.schemaname = 'public' and pv.viewname = v.name
             where pv.definition like '%osp_private.supply_rates_registry_mv%'
               and pv.definition like '%osp_private.supply_registry_rates%'
               and pv.definition not like '%view_supply_registry_rates%'
               and pv.definition like '%osp_registry_reader()%') = 4,
         'четыре представления реестра СУ-10 читают загруженные строки напрямую и только читателю реестра'
  union all
  select 4, (select string_agg(column_name::text, ',' order by ordinal_position) from information_schema.columns
             where table_schema = 'public' and table_name = 'supply_rates_registry')
            = 'id,source_type,source_name,item_name,unit,price,tender_id,object_id,tender_desc,object_name,rate_date,import_id,'
              'contractor_label,doc_number,order_number,source_file,invoice_url,object_label,tender_label,row_no',
         'у реестра прежние колонки на своих местах, подробности загруженной расценки — в конце'
  union all
  select 5, exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'supply_registry_import' and not p.prosecdef
                      and p.prosrc like '%osp_private.supply_registry_rates%' and p.prosrc like '%invoice_url%'
                      and p.prosrc like '%osp_can(''rates_registry'', ''edit'')%'),
         'загрузка порцией — с правами вызывающего, проверкой права правки и новыми полями'
  union all
  select 6, exists (select 1 from pg_trigger where tgname = 'supply_registry_rates_object_name'
                      and tgrelid = 'public.objects'::regclass and tgenabled = 'O')
            and exists (select 1 from pg_trigger where tgname = 'supply_registry_rates_tender_desc'
                          and tgrelid = 'public.tenders'::regclass and tgenabled = 'O')
            and not exists (select 1 from osp_private.supply_registry_rates m join public.objects o on o.id = m.object_id
                            where m.object_name is distinct from o.name)
            and not exists (select 1 from osp_private.supply_registry_rates m join public.tenders t on t.id = m.tender_id
                            where m.tender_desc is distinct from t.work_description),
         'названия объекта и тендера у загруженных строк — как в портале; переименуют — обновятся триггером'
  union all
  -- Загрузка, у которой не осталось строк, возможна (все строки уже были в реестре), но строк без загрузки быть не может.
  select 7, not exists (select 1 from osp_private.supply_registry_rates m
                        where not exists (select 1 from public.supply_registry_imports i where i.id = m.import_id))
            and not exists (select 1 from osp_private.supply_registry_rates
                            where invoice_url is not null and invoice_url !~* '^https?://\S+$'),
         'перенесённые строки — при своих загрузках; ссылки на счёт — только http/https'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
