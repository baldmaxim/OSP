-- После 20270305_bid_supply_docs_preview: счета снабжения в просмотре кабинета от имени подрядчика — по открытым позициям.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
docs as (select p.* from pg_proc p where p.oid = to_regprocedure('public.bid_supply_docs(uuid,uuid)')),
open_fn as (select p.* from pg_proc p where p.oid = to_regprocedure('osp_private.bid_supply_open_doc_rows(uuid,uuid)')),
rows_fn as (select p.* from pg_proc p where p.oid = to_regprocedure('osp_private.bid_supply_doc_rows(uuid,uuid)')),
file as (select p.* from pg_proc p where p.oid = to_regprocedure('public.bid_supply_doc_file(uuid,uuid)')),
checks(n, ok, what) as (
  select 1, coalesce((select prosecdef and proconfig @> array['application_name=osp:internal']
                             and pg_get_function_result(oid) = 'TABLE(item_key text, unit_key text, document_id uuid, file_name text, uploaded_at timestamp with time zone)'
                      from docs), false),
         'bid_supply_docs — служебная функция с отметкой, ответ прежний (списки шлюза не меняются)'
  union all
  select 2, coalesce((select prosrc like '%bid_supply_docs_cp%' and prosrc like '%is_admin()%' and prosrc like '%osp_counterparty_id() IS NULL%'
                             and prosrc like '%bid_supply_open_doc_rows%' and prosrc like '%bid_supply_doc_rows(p_tender, v_cp)%'
                      from docs), false),
         'по открытым позициям — только администратору (просмотр); подрядчику — только к взятой цене, с разрешением отдела'
  union all
  select 3, coalesce((select not prosecdef and prosrc like '%bid_supply_open_rows%' and prosrc like '%s3_document_id%' from open_fn), false),
         'документы — только позиций, открытых отделом организации; только файлы'
  union all
  select 4, coalesce((select prosrc like '%source = ''supply''%' and prosrc like '%x.price = b.price%' from rows_fn), false)
            and coalesce((select prosrc like '%bid_supply_doc_rows%' and prosrc not like '%bid_supply_open_doc_rows%' from file), false),
         'скачивание подрядчиком — по-прежнему только счёт взятой и не изменённой цены'
  union all
  select 5, true,
         'взято цен снабжения — ' || (select count(*) from public.tender_bid_rates where source = 'supply' and price is not null)
           || '; разрешений — ' || (select count(*) from public.tender_bid_supply_access where status = 'granted')
           || '; открытых позиций — ' || (select count(*) from public.tender_bid_supply_items)
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
