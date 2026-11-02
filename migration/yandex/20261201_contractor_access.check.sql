-- После 20261201_contractor_access: кабинет подрядчика читает сведения функциями с перечнем полей.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
closed(tbl) as (values ('tenders'), ('objects'), ('contracts'), ('contract_counterparties'), ('counterparties'), ('tender_counterparties')),
pol as (
  select tablename, policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public'
),
fn(sig) as (values ('public.contractor_org_name()'), ('public.contractor_contracts()'),
  ('public.contractor_set_participation(uuid,text)'), ('public.contractor_kp_item_open(uuid,uuid)')),
checks(n, ok, what) as (
  select 1, not exists (select 1 from pol where tablename in (select tbl from closed) and policyname in ('portal_contractor_select', 'portal_contractor_update')),
         'прямых правил подрядчика на тендеры, объекты, договоры, организацию и строку участия нет'
  union all
  select 2, not exists (select 1 from osp_meta.policy_roles r
              where r.schema_name = 'public' and r.table_name in (select tbl from closed)
                and r.policy_name in ('portal_contractor_select', 'portal_contractor_update')),
         'записей о ролях снятых правил нет'
  union all
  select 3, (select count(*) from fn
              join pg_proc p on p.oid = to_regprocedure(fn.sig)
              where p.prosecdef and 'application_name=osp:internal' = any (coalesce(p.proconfig, '{}'))) = 4,
         'функции кабинета на месте: служебные, с отметкой пропуска'
  union all
  select 4, exists (select 1 from pol where tablename = 'tender_counterparty_proposals' and policyname = 'portal_contractor_insert' and cmd = 'INSERT'
                      and chk like '%contractor_kp_item_open(tender_id, estimate_item_id)%' and chk like '%is_my_tender(tender_id)%' and chk like '%bypass%')
            and exists (select 1 from pol where tablename = 'tender_counterparty_proposals' and policyname = 'portal_contractor_delete' and cmd = 'DELETE'
                          and qual like '%bid_tender_open(tender_id)%' and qual like '%current_counterparty_id()%' and qual like '%bypass%'),
         'свои КП подрядчик меняет, только пока идёт приём'
  union all
  select 5, (select count(*) from pol where policyname = 'portal_contractor_select'
               and tablename in ('tender_counterparty_proposals', 'tender_estimate_items', 's3_documents')) = 3,
         'смета, файлы и свои КП подрядчику видны, как раньше'
  union all
  select 6, (select count(*) from pol where policyname = 'portal_employee_all'
               and tablename in ('tenders', 'contracts', 'contract_counterparties', 'tender_counterparties', 'tender_counterparty_proposals')) = 5,
         'правила сотрудников на месте'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
