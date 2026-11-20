-- Проверка после 20270223_supply_removed_docs.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: объекты ищутся через to_regclass.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk, roles from pg_policies
  where schemaname = 'public' and tablename = 'tender_supply_removed_docs'
),
trg as (
  select tg.tgname from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not tg.tgisinternal and c.relname = 'tender_supply_removed_docs'
),
fk as (
  select pg_get_constraintdef(oid) as def from pg_constraint
  where conrelid = to_regclass('public.tender_supply_removed_docs') and contype = 'f'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.tender_supply_removed_docs')), false),
         'следы удалённых файлов расценки: таблица создана, RLS включён'
  union all
  select 2, (select count(*) from pol where roles = '{authenticated}') = 4
            and exists (select 1 from pol where cmd = 'SELECT' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where cmd in ('INSERT', 'UPDATE', 'DELETE') and qual || chk like '%supply_can_edit()%') = 3,
         'читает сотрудник; пишет только право правки «Тендеры» или «Тендеры на материалы»'
  union all
  select 3, coalesce(not has_table_privilege('anon', to_regclass('public.tender_supply_removed_docs'), 'select'), false),
         'гостю ничего не выдано'
  union all
  select 4, (select count(*) from trg where tgname in ('tender_supply_removed_docs_touch', 'tender_supply_removed_docs_guard')) = 2,
         'триггеры «кто и когда» и закрытия на месте'
  union all
  select 5, exists (select 1 from fk where def like '%(rate_id)%REFERENCES tender_vor_supply_rates(id)%ON DELETE CASCADE%'),
         'цену очистили — след уходит сам (ON DELETE CASCADE)'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
