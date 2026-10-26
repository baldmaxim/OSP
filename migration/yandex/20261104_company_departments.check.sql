-- После 20261104_company_departments: отделы компании — таблица, триггер, права под одну учётку и начальный
-- список. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename = 'company_departments'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity and c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'company_departments' and c.relkind = 'r'), false),
         'отделы: таблица есть, правила по строкам включены и действуют на владельца'
  union all
  select 2, exists (select 1 from pol where policyname = 'osp_internal')
            and (select count(*) from pol where policyname <> 'osp_internal' and qual || chk like '%role_in(%authenticated%') = 4
            and exists (select 1 from pol where cmd = 'SELECT' and policyname <> 'osp_internal' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where cmd in ('INSERT', 'UPDATE', 'DELETE') and policyname <> 'osp_internal'
                   and qual || chk like '%is_admin()%') = 3,
         'пропуск служебных операций; читает сотрудник, правит только администратор'
  union all
  select 3, (select count(*) from osp_meta.policy_roles where schema_name = 'public' and table_name = 'company_departments'
             and roles = array['authenticated']) = 4,
         'записи о ролях четырёх политик'
  union all
  select 4, exists (select 1 from pg_trigger tg where tg.tgrelid = 'public.company_departments'::regclass
                      and tg.tgname = 'company_departments_touch' and not tg.tgisinternal),
         'триггер «очистка и кто изменил» на месте'
  union all
  select 5, (select count(*) from public.company_departments) >= 26
            and not exists (select 1 from public.company_departments where jsonb_typeof(contacts) <> 'array'),
         'начальный список отделов заведён, контакты — списки'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
