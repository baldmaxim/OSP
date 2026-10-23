-- Проверка после 20261102_contractor_bids.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: объекты ищутся через to_regclass / to_regprocedure.
with
tbl(name) as (values ('tender_bid_requests'), ('tender_bid_rates'), ('bid_form_fields'), ('tender_bid_forms')),
pol as (
  select tablename, policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk, roles from pg_policies
  where schemaname = 'public' and tablename in (select name from tbl)
),
fn(sig) as (values ('public.bid_tender_open(uuid)'), ('public.bid_access(uuid)'), ('public.bid_can_edit(uuid)'),
  ('public.bid_contractor_tenders()'), ('public.bid_request(uuid)'), ('public.bid_decide(uuid,boolean)'),
  ('public.bid_rates_save(uuid,jsonb)'), ('public.bid_form_save(uuid,jsonb)'), ('public.bid_admin_overview()')),
checks(n, ok, what) as (
  select 1, (select count(*) from tbl t join pg_class c on c.oid = to_regclass('public.' || t.name) where c.relrowsecurity) = 4,
         'четыре таблицы кабинета подрядчика созданы, RLS включён'
  union all
  select 2, (select count(*) from pol where roles = '{authenticated}') = 5
            and not exists (select 1 from pol where tablename <> 'bid_form_fields' and cmd <> 'SELECT')
            and (select count(*) from pol where tablename in ('tender_bid_rates', 'tender_bid_forms') and cmd = 'SELECT'
                   and qual like '%is_admin()%' and qual like '%osp_counterparty_id()%') = 2,
         'заявки — сотрудник и организация, цены и анкета — администратор и организация, прямой записи нет'
  union all
  select 3, coalesce((select bool_and(not has_table_privilege('anon', to_regclass('public.' || t.name), 'select')
                                     and not has_table_privilege('authenticated', to_regclass('public.' || t.name), 'insert'))
                      from tbl t where t.name <> 'bid_form_fields'), false)
            and (select count(*) from tbl t where to_regclass('public.' || t.name) is not null) = 4,
         'гостю ничего не выдано; заявки, цены и анкету вошедший пишет только функциями'
  union all
  select 4, (select count(*) from fn f join pg_proc p on p.oid = to_regprocedure(f.sig) where p.prosecdef
               and not has_function_privilege('anon', p.oid, 'execute')) = 9,
         'девять функций кабинета есть, гостю не выданы'
  union all
  select 5, exists (select 1 from pg_policies where schemaname = 'public' and tablename = 's3_documents' and policyname = 'portal_contractor_select'
                      and qual like '%is_my_tender(owner_id)%' and qual like '%bid_access(owner_id)%' and qual like '%is_my_contract(owner_id)%'),
         'файлы подрядчику: свои тендеры и договоры, как раньше, плюс открытый тендер после заявки'
  union all
  select 6, coalesce((select count(*) from pg_constraint where contype = 'u'
             and conname in ('tender_bid_requests_key', 'tender_bid_rates_key', 'tender_bid_forms_key')) = 3, false),
         'одна заявка, одна анкета и одна цена позиции на тендер и организацию'
  union all
  select 7, coalesce((select count(*) from pg_constraint where contype = 'u' and conname = 'bid_form_fields_code_key') = 1, false)
            and to_regclass('public.bid_form_fields') is not null
            and exists (select 1 from pg_attribute where attrelid = to_regclass('public.bid_form_fields') and attname = 'options' and not attisdropped),
         'поля анкеты: текст или выбор из списка, у ставки НДС — свой код'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
