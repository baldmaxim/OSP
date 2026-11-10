-- Проверка после 20270106_contracts_registry_site_staff.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции; до миграции отвечает FAIL, а не падает.
with
perm as (
  select r.key, rp.can_view, rp.can_edit
  from public.roles r
  left join public.role_permissions rp on rp.role = r.key and rp.section = 'contracts'
  where r.key in ('construction_manager', 'economist_object')
),
checks(n, ok, what) as (
  select 1, not exists (select 1 from perm where can_view is distinct from true or can_edit is distinct from false),
         'руководитель строительства и экономист объекта: «Договоры» — просмотр без правки'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
