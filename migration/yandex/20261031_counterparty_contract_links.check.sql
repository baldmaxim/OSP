-- После 20261031_counterparty_contract_links: договоры, прикреплённые к контрагенту вручную, — таблица, триггер и
-- права под одну учётку. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой
-- служебной операции.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename = 'counterparty_contract_links'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity and c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'counterparty_contract_links' and c.relkind = 'r'), false),
         'привязки договоров: таблица есть, правила по строкам включены и действуют на владельца'
  union all
  select 2, exists (select 1 from pol where policyname = 'osp_internal')
            and (select count(*) from pol where policyname <> 'osp_internal' and qual || chk like '%role_in(%authenticated%') = 3
            and exists (select 1 from pol where cmd = 'SELECT' and policyname <> 'osp_internal' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where cmd in ('INSERT', 'DELETE') and policyname <> 'osp_internal'
                   and qual || chk like '%osp_can(%counterparties%edit%') = 2
            and not exists (select 1 from pol where cmd = 'UPDATE'),
         'пропуск служебных операций; читает сотрудник, прикрепляет и открепляет право правки «Контрагентов», изменять нельзя'
  union all
  select 3, (select count(*) from osp_meta.policy_roles where schema_name = 'public' and table_name = 'counterparty_contract_links'
             and roles = array['authenticated']) = 3,
         'записи о ролях трёх политик'
  union all
  select 4, exists (select 1 from pg_trigger tg where tg.tgrelid = 'public.counterparty_contract_links'::regclass
                      and tg.tgname = 'counterparty_contract_links_stamp' and not tg.tgisinternal),
         'триггер «кто и когда прикрепил» на месте'
  union all
  select 5, (select count(*) from pg_constraint where conrelid = 'public.counterparty_contract_links'::regclass and contype = 'f'
               and confdeltype = 'c' and confrelid in ('public.counterparties'::regclass, 'public.contracts'::regclass)) = 2
            and exists (select 1 from pg_constraint where conrelid = 'public.counterparty_contract_links'::regclass
                          and conname = 'counterparty_contract_links_key' and contype = 'u'),
         'одна привязка на контрагента и договор, удаление контрагента или договора удаляет привязку'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
