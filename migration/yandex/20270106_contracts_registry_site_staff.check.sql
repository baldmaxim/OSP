-- После 20270106_contracts_registry_site_staff: руководитель строительства и экономист объекта — «Договоры»: просмотр без правки.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
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
  union all
  select 2, exists (select 1 from public.role_permissions where section = 'dp_requests_create'),
         'право «Заявка на заключение ДП: создание» на месте (20261227): кнопка в реестре договоров — по нему'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
