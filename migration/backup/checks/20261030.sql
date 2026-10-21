-- Проверка после 20261030_site_contacts.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: объекты ищутся через to_regclass.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk, roles from pg_policies
  where schemaname = 'public' and tablename = 'object_site_contacts'
),
checks(n, ok, what) as (
  select 1, (select count(*) from pg_constraint
             where conname in ('valid_vor_division', 'vor_requests_division_check')
               and conrelid in (to_regclass('public.tenders'), to_regclass('public.vor_requests'))
               and pg_get_constraintdef(oid) like '%finishing%') = 2,
         'подразделение «Отделка» разрешено у тендеров и заявок на ВОР'
  union all
  select 2, coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.object_site_contacts')), false),
         'контакты площадки: таблица создана, RLS включён'
  union all
  select 3, (select count(*) from pol where roles = '{authenticated}') = 4
            and exists (select 1 from pol where cmd = 'SELECT' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where cmd in ('INSERT', 'UPDATE', 'DELETE') and qual || chk like '%is_admin()%') = 3,
         'читает сотрудник; назначает только администратор'
  union all
  select 4, coalesce(not has_table_privilege('anon', to_regclass('public.object_site_contacts'), 'select'), false),
         'гостю ничего не выдано'
  union all
  select 5, exists (select 1 from pg_trigger tg where tg.tgrelid = to_regclass('public.object_site_contacts')
                      and tg.tgname = 'object_site_contacts_touch' and not tg.tgisinternal),
         'триггер «кто изменил» на месте'
  union all
  select 6, exists (select 1 from pg_constraint where conrelid = to_regclass('public.object_site_contacts') and contype = 'f'
                      and confdeltype = 'c' and confrelid = to_regclass('public.objects'))
            and exists (select 1 from pg_constraint where conrelid = to_regclass('public.object_site_contacts')
                          and conname = 'object_site_contacts_object_division_key'),
         'один контакт на объект и подразделение, удаление объекта удаляет его контакты'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
