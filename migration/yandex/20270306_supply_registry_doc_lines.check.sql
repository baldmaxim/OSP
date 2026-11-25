-- После 20270306_supply_registry_doc_lines: строки счетов и КП тендеров — в реестре СУ-10. Строки «OK …» / «FAIL …»;
-- выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции (пункт 3 вызывает функции разбора этой миграции).
with
tbl as (select c.oid, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'osp_private' and c.relname = 'supply_doc_rates' and c.relkind = 'r'),
fn as (select p.proname, p.prosrc, p.proconfig, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname = 'osp_private' and p.proname in ('supply_offer_lines', 'supply_doc_rates_sync', 'supply_doc_rates_on_doc',
                                                            'supply_doc_rates_names', 'supply_doc_price_hit'))
          or (n.nspname = 'public' and p.proname = 'supply_doc_rates_status')),
docs as (select s.id from public.s3_documents s
         where s.doc_category = 'supply_doc' and s.owner_type = 'tender'
           and exists (select 1 from public.tenders t where t.id = s.owner_id)
           and strpos(coalesce(s.notes, ''), 'supply_offer') > 0),
checks(n, ok, what) as (
  select 1, (select count(*) from tbl where not relrowsecurity) = 1
            and (select count(*) from pg_indexes where schemaname = 'osp_private' and tablename = 'supply_doc_rates'
                 and indexname in ('supply_doc_rates_reg_id', 'supply_doc_rates_name_idx', 'supply_doc_rates_name_trgm',
                                   'supply_doc_rates_date_idx', 'supply_doc_rates_same_idx')) = 5,
         'строки счетов — в закрытой схеме (PostgREST не видит), поиск, порядок и «та же строка» — по индексам'
  union all
  select 2, (select count(*) from pg_trigger where tgrelid = 'public.s3_documents'::regclass and tgenabled = 'O'
             and tgname in ('s3_documents_supply_doc_rates_ins', 's3_documents_supply_doc_rates_upd', 's3_documents_supply_doc_rates_del')) = 3
            and exists (select 1 from pg_trigger where tgrelid = 'public.objects'::regclass and tgname = 'supply_doc_rates_object_name')
            and exists (select 1 from pg_trigger where tgrelid = 'public.tenders'::regclass and tgname = 'supply_doc_rates_tender')
            and coalesce((select prosrc like '%EXCEPTION WHEN others%' from fn where proname = 'supply_doc_rates_on_doc'), false),
         'файл загрузили, изменили, удалили — строки следом; сбой разбора работу с файлом не прерывает'
  union all
  -- Каждый файл счёта / КП со строками с ценой — в реестре столько строк, сколько их в файле.
  select 3, not exists (
              select 1 from docs d
              where (select count(*) from osp_private.supply_offer_lines(osp_private.supply_offer_json(
                       (select s.notes from public.s3_documents s where s.id = d.id))) l
                     where round(l.price, 2) > 0 and l.price < 1e12)
                 <> (select count(*) from osp_private.supply_doc_rates r where r.doc_id = d.id and r.doc_deleted_at is null)),
         'уже загруженные счета и КП тендеров — в реестре все свои строки с ценой'
  union all
  select 4, not exists (select 1 from osp_private.supply_doc_rates r
                        where r.doc_deleted_at is null
                          and not exists (select 1 from public.s3_documents s
                                          where s.id = r.doc_id and s.doc_category = 'supply_doc' and s.owner_type = 'tender')),
         'строки файлов, которых в тендере нет, отмечены «файл удалён»'
  union all
  select 5, (select string_agg(column_name::text, ',' order by ordinal_position) from information_schema.columns
             where table_schema = 'public' and table_name = 'supply_rates_registry')
            = 'id,source_type,source_name,item_name,unit,price,tender_id,object_id,tender_desc,object_name,rate_date,import_id,'
              'contractor_label,doc_number,order_number,source_file,invoice_url,object_label,tender_label,row_no,doc_id,doc_deleted_at'
            and (select count(*) from pg_views where schemaname = 'public'
                 and viewname in ('supply_rates_registry', 'supply_rates_registry_filter_objects',
                                  'supply_rates_registry_filter_tenders', 'supply_rates_registry_units')
                 and definition like '%osp_private.supply_doc_rates%' and definition like '%osp_registry_reader()%') = 4,
         'реестр СУ-10: прежние колонки на своих местах, файл строки и «файл удалён» — в конце; строки счетов — во всех четырёх представлениях, только читателю реестра'
  union all
  select 6, coalesce((select prosrc like '%osp_registry_reader()%' and prosrc like '%tender_supply_removed_docs%'
                             and prosecdef and 'application_name=osp:internal' = any (proconfig)
                      from fn where proname = 'supply_doc_rates_status'), false)
            and coalesce((select 'application_name=osp:internal' = any (proconfig) from fn where proname = 'supply_doc_rates_sync'), false),
         'статус «применена в тендере» — только читателю реестра, по документам позиций и следам удалённых файлов'
  union all
  select 7, not exists (select 1 from osp_private.supply_doc_rates r join public.tenders t on t.id = r.tender_id
                        where r.tender_desc is distinct from t.work_description or r.object_id is distinct from t.object_id)
            and not exists (select 1 from osp_private.supply_doc_rates r join public.objects o on o.id = r.object_id
                            where r.object_name is distinct from o.name),
         'объект и описание тендера у строк счетов — как в портале'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
