-- После 20261226_contractor_org_card_vor_file: карточка компании отдаёт только перечисленные поля, файл ВОР — служебная функция с отметкой.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
checks(n, ok, what) as (
  select 1, (select pg_get_function_result('public.contractor_org_card()'::regprocedure) =
             'TABLE(name text, inn text, kpp text, legal_address text, actual_address text, website text, work_type text, contact_name text, contact_phone text, contact_email text, counterparty_number integer, vat_rate numeric, vat_exempt boolean, contacts jsonb)'),
         'contractor_org_card: прежние поля, номер на сайте, НДС и контактные лица; статуса и примечаний нет'
  union all
  select 2, (select prosecdef and proconfig @> array['application_name=osp:internal']
             from pg_proc where oid = 'public.contractor_org_card()'::regprocedure),
         'contractor_org_card: служебная функция с отметкой'
  union all
  select 3, (select pg_get_function_result('public.bid_vor_file(uuid)'::regprocedure) = 'TABLE(s3_key text, file_name text)'),
         'bid_vor_file отдаёт только ключ и имя файла'
  union all
  select 4, (select prosecdef and proconfig @> array['application_name=osp:internal']
             from pg_proc where oid = 'public.bid_vor_file(uuid)'::regprocedure),
         'bid_vor_file: служебная функция с отметкой'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
