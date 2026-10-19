-- Проверка после 20261024_supply_import_state.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: таблица ищется через to_regclass.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, roles from pg_policies
  where schemaname = 'public' and tablename = 'tender_supply_import_state'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.tender_supply_import_state')), false),
         'состояние разбора позиций ВОР: таблица создана, RLS включён'
  union all
  select 2, (select count(*) from pol) = 1
            and exists (select 1 from pol where cmd = 'SELECT' and roles = '{authenticated}' and qual like '%osp_is_employee()%'),
         'читает сотрудник; правил записи для вошедших нет'
  union all
  select 3, coalesce(has_table_privilege('authenticated', to_regclass('public.tender_supply_import_state'), 'select')
                 and not has_table_privilege('authenticated', to_regclass('public.tender_supply_import_state'), 'insert')
                 and not has_table_privilege('authenticated', to_regclass('public.tender_supply_import_state'), 'update')
                 and not has_table_privilege('authenticated', to_regclass('public.tender_supply_import_state'), 'delete')
                 and not has_table_privilege('anon', to_regclass('public.tender_supply_import_state'), 'select'), false),
         'вошедшему — только чтение, гостю — ничего'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
