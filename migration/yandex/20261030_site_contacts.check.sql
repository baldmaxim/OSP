-- После 20261030_site_contacts: подразделение «Отделка» и контакты площадки — таблица, триггер и права под
-- одну учётку. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной
-- операции.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename = 'object_site_contacts'
),
checks(n, ok, what) as (
  select 1, (select count(*) from pg_constraint
             where conname in ('valid_vor_division', 'vor_requests_division_check')
               and conrelid in ('public.tenders'::regclass, 'public.vor_requests'::regclass)
               and pg_get_constraintdef(oid) like '%finishing%') = 2,
         'подразделение «Отделка» разрешено у тендеров и заявок на ВОР'
  union all
  select 2, coalesce((select c.relrowsecurity and c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'object_site_contacts' and c.relkind = 'r'), false),
         'контакты площадки: таблица есть, правила по строкам включены и действуют на владельца'
  union all
  select 3, exists (select 1 from pol where policyname = 'osp_internal')
            and (select count(*) from pol where policyname <> 'osp_internal' and qual || chk like '%role_in(%authenticated%') = 4
            and exists (select 1 from pol where cmd = 'SELECT' and policyname <> 'osp_internal' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where cmd in ('INSERT', 'UPDATE', 'DELETE') and policyname <> 'osp_internal'
                   and qual || chk like '%is_admin()%') = 3,
         'пропуск служебных операций; читает сотрудник, назначает только администратор'
  union all
  select 4, (select count(*) from osp_meta.policy_roles where schema_name = 'public' and table_name = 'object_site_contacts'
             and roles = array['authenticated']) = 4,
         'записи о ролях четырёх политик'
  union all
  select 5, exists (select 1 from pg_trigger tg where tg.tgrelid = 'public.object_site_contacts'::regclass
                      and tg.tgname = 'object_site_contacts_touch' and not tg.tgisinternal),
         'триггер «кто изменил» на месте'
  union all
  select 6, exists (select 1 from pg_constraint where conrelid = 'public.object_site_contacts'::regclass and contype = 'f'
                      and confdeltype = 'c' and confrelid = 'public.objects'::regclass)
            and exists (select 1 from pg_constraint where conrelid = 'public.object_site_contacts'::regclass
                          and conname = 'object_site_contacts_object_division_key' and contype = 'u'),
         'один контакт на объект и подразделение, удаление объекта удаляет его контакты'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
