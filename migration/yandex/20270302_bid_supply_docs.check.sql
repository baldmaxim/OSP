-- После 20270302_bid_supply_docs: счета снабжения к взятым ценам в кабинете подрядчика, прошлые цены одним запросом.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
docs as (select p.* from pg_proc p where p.oid = to_regprocedure('public.bid_supply_docs(uuid,uuid)')),
file as (select p.* from pg_proc p where p.oid = to_regprocedure('public.bid_supply_doc_file(uuid,uuid)')),
hist as (select p.* from pg_proc p where p.oid = to_regprocedure('public.bid_rate_history(uuid,text[])')),
rows_fn as (select p.* from pg_proc p where p.oid = to_regprocedure('osp_private.bid_supply_doc_rows(uuid,uuid)')),
gate as (select p.* from pg_proc p where p.oid = to_regprocedure('osp_private.bid_supply_docs_cp(uuid,uuid)')),
checks(n, ok, what) as (
  select 1, (select count(*) from (select * from docs union all select * from file) f
             where f.prosecdef and f.proconfig @> array['application_name=osp:internal']) = 2,
         'bid_supply_docs, bid_supply_doc_file — служебные функции с отметкой'
  union all
  select 2, coalesce((select pg_get_function_result(oid) = 'TABLE(item_key text, unit_key text, document_id uuid, file_name text, uploaded_at timestamp with time zone)'
                      from docs), false)
            and coalesce((select pg_get_function_result(oid) = 'TABLE(s3_key text, file_name text)' from file), false),
         'подрядчику — ключ позиции, id, имя и дата файла; ключ хранилища — только службе'
  union all
  select 3, coalesce((select prosrc like '%status = ''granted''%' and prosrc like '%bid_tender_open%' and prosrc like '%osp_is_employee%' from gate), false)
            and coalesce((select prosrc like '%bid_supply_docs_cp%' from docs), false)
            and coalesce((select prosrc like '%bid_supply_docs_cp%' and prosrc like '%bid_supply_doc_rows%' from file), false),
         'счета — только с разрешением отдела и пока идёт приём; файл — только из списка организации'
  union all
  select 4, coalesce((select prosrc like '%source = ''supply''%' and prosrc like '%x.price = b.price%' and prosrc like '%s3_document_id%'
                      from rows_fn), false),
         'счета — только к цене, взятой у снабжения и не изменённой; только файлы (адресных ссылок нет)'
  union all
  select 5, coalesce((select not prosecdef and prosrc like '%osp_counterparty_id()%' and prosrc like '%source <> ''supply''%' from hist), false),
         'прошлые цены — с правами вызывающего, только своей организации, без цен снабжения'
  union all
  select 6, (select qual not like '%supply_doc%' from (select pg_get_expr(p.polqual, p.polrelid) as qual from pg_policy p
             where p.polrelid = 'public.s3_documents'::regclass and p.polname = 'portal_contractor_select') q),
         'строки файлов счетов подрядчику по-прежнему закрыты (правило s3_documents не менялось)'
  union all
  select 7, true,
         'взято цен снабжения — ' || (select count(*) from public.tender_bid_rates where source = 'supply' and price is not null)
           || '; разрешений — ' || (select count(*) from public.tender_bid_supply_access where status = 'granted')
           || '; файлов-документов у позиций снабжения — ' || (select count(*) from public.tender_supply_links where s3_document_id is not null)
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
