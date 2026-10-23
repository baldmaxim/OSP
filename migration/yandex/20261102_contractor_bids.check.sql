-- После 20261102_contractor_bids: кабинет подрядчика — заявки, цены, анкета, правило подрядчика на файлы.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
tbl(name) as (values ('tender_bid_requests'), ('tender_bid_rates'), ('bid_form_fields'), ('tender_bid_forms')),
pol as (
  select tablename, policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename in (select name from tbl)
),
fn(name) as (values ('bid_tender_open'), ('bid_access'), ('bid_can_edit'), ('bid_contractor_tenders'), ('bid_request'),
  ('bid_decide'), ('bid_rates_save'), ('bid_form_save'), ('bid_admin_overview')),
checks(n, ok, what) as (
  select 1, (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname in (select name from tbl) and c.relkind = 'r'
               and c.relrowsecurity and c.relforcerowsecurity) = 4,
         'четыре таблицы кабинета есть, правила по строкам включены и действуют на владельца'
  union all
  select 2, (select count(*) from pol where policyname = 'osp_internal') = 4
            and (select count(*) from pol where policyname <> 'osp_internal' and qual || chk like '%role_in(%authenticated%') = 5
            and exists (select 1 from pol where tablename = 'tender_bid_requests' and cmd = 'SELECT' and qual like '%osp_is_employee()%' and qual like '%osp_counterparty_id()%')
            and (select count(*) from pol where tablename in ('tender_bid_rates', 'tender_bid_forms') and cmd = 'SELECT'
                   and qual like '%is_admin()%' and qual like '%osp_counterparty_id()%') = 2
            and exists (select 1 from pol where tablename = 'bid_form_fields' and cmd = 'ALL' and policyname <> 'osp_internal' and qual like '%is_admin()%')
            and not exists (select 1 from pol where tablename <> 'bid_form_fields' and policyname <> 'osp_internal' and cmd <> 'SELECT'),
         'пропуск служебных операций; заявки — сотрудник и организация, цены и анкета — администратор и организация, поля анкеты правит администратор, прямой записи в заявки, цены и анкету нет'
  union all
  select 3, (select count(*) from osp_meta.policy_roles where schema_name = 'public'
             and (table_name, policy_name) in (('tender_bid_requests', 'tender_bid_requests_read'), ('tender_bid_rates', 'tender_bid_rates_read'),
                  ('tender_bid_forms', 'tender_bid_forms_read'), ('bid_form_fields', 'bid_form_fields_read'),
                  ('bid_form_fields', 'bid_form_fields_write'), ('s3_documents', 'portal_contractor_select'))
             and roles = array['authenticated']) = 6,
         'записи о ролях шести политик'
  union all
  select 4, (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname in (select name from fn) and p.prosecdef
               and 'application_name=osp:internal' = any (p.proconfig)) = 9,
         'девять функций кабинета — служебные (SECURITY DEFINER с отметкой пропуска)'
  union all
  select 5, exists (select 1 from pg_policies where schemaname = 'public' and tablename = 's3_documents' and policyname = 'portal_contractor_select'
                      and qual like '%is_my_tender(owner_id)%' and qual like '%bid_access(owner_id)%' and qual like '%is_my_contract(owner_id)%'
                      and qual like '%role_in(%authenticated%'),
         'файлы подрядчику: свои тендеры и договоры, как раньше, плюс открытый тендер после заявки'
  union all
  select 6, (select count(*) from pg_constraint where contype = 'u'
             and conname in ('tender_bid_requests_key', 'tender_bid_rates_key', 'tender_bid_forms_key')) = 3
            and (select count(*) from pg_constraint where contype = 'f' and confdeltype = 'c'
                   and conrelid in ('public.tender_bid_requests'::regclass, 'public.tender_bid_rates'::regclass, 'public.tender_bid_forms'::regclass)) = 6,
         'одна заявка, одна анкета и одна цена позиции на тендер и организацию; удаление тендера или организации удаляет их'
  union all
  select 7, (select count(*) from public.bid_form_fields) > 0
            and exists (select 1 from public.bid_form_fields where code = 'vat' and kind = 'select' and jsonb_array_length(options) > 0),
         'анкета по умолчанию заведена, ставка НДС — выбор из списка'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
