-- Проверка после 20261031_counterparty_contract_links.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: объекты ищутся через to_regclass.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk, roles from pg_policies
  where schemaname = 'public' and tablename = 'counterparty_contract_links'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.counterparty_contract_links')), false),
         'привязки договоров: таблица создана, RLS включён'
  union all
  select 2, (select count(*) from pol where roles = '{authenticated}') = 3
            and exists (select 1 from pol where cmd = 'SELECT' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where cmd in ('INSERT', 'DELETE') and qual || chk like '%osp_can(%counterparties%edit%') = 2,
         'читает сотрудник; прикрепляет и открепляет право правки «Контрагентов»'
  union all
  select 3, coalesce(not has_table_privilege('anon', to_regclass('public.counterparty_contract_links'), 'select')
                     and not has_table_privilege('authenticated', to_regclass('public.counterparty_contract_links'), 'update'), false),
         'гостю ничего не выдано, изменять привязку нельзя'
  union all
  select 4, exists (select 1 from pg_trigger tg where tg.tgrelid = to_regclass('public.counterparty_contract_links')
                      and tg.tgname = 'counterparty_contract_links_stamp' and not tg.tgisinternal),
         'триггер «кто и когда прикрепил» на месте'
  union all
  select 5, (select count(*) from pg_constraint where conrelid = to_regclass('public.counterparty_contract_links') and contype = 'f'
               and confdeltype = 'c' and confrelid in (to_regclass('public.counterparties'), to_regclass('public.contracts'))) = 2
            and exists (select 1 from pg_constraint where conrelid = to_regclass('public.counterparty_contract_links')
                          and conname = 'counterparty_contract_links_key'),
         'одна привязка на контрагента и договор, удаление контрагента или договора удаляет привязку'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
