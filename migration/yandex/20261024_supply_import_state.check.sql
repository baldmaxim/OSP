-- После 20261024_supply_import_state: состояние разбора позиций ВОР службой osp-api — таблица и права под одну
-- учётку. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename = 'tender_supply_import_state'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity and c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'tender_supply_import_state' and c.relkind = 'r'), false),
         'состояние разбора: таблица есть, правила по строкам включены и действуют на владельца'
  union all
  select 2, exists (select 1 from pol where policyname = 'osp_internal')
            and (select count(*) from pol where policyname <> 'osp_internal') = 1
            and exists (select 1 from pol where cmd = 'SELECT' and policyname <> 'osp_internal'
                          and qual like '%role_in(%authenticated%' and qual like '%osp_is_employee()%'),
         'пропуск служебных операций; читает сотрудник, правил записи для вошедших нет'
  union all
  select 3, (select count(*) from osp_meta.policy_roles where schema_name = 'public' and table_name = 'tender_supply_import_state'
             and roles = array['authenticated']) = 1,
         'запись о ролях политики чтения'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
