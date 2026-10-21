-- Проверка после 20261027_vor_rd_sets.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: объекты ищутся через to_regclass.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk, roles from pg_policies
  where schemaname = 'public' and tablename = 'vor_rd_sets'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.vor_rd_sets')), false),
         'комплекты РД: таблица создана, RLS включён'
  union all
  select 2, (select count(*) from pol where roles = '{authenticated}') = 4
            and exists (select 1 from pol where cmd = 'SELECT' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where cmd in ('INSERT', 'UPDATE', 'DELETE') and qual || chk like '%vor_rd_can_edit()%') = 3,
         'читает сотрудник; пишет только право правки «Тендеры» или «ВОРы и РД»'
  union all
  select 3, coalesce(not has_table_privilege('anon', to_regclass('public.vor_rd_sets'), 'select'), false),
         'гостю ничего не выдано'
  union all
  select 4, exists (select 1 from pg_trigger tg where tg.tgrelid = to_regclass('public.vor_rd_sets')
                      and tg.tgname = 'vor_rd_sets_touch' and not tg.tgisinternal),
         'триггер «кто изменил» на месте'
  union all
  select 5, (select count(*) from pg_constraint where conrelid = to_regclass('public.vor_rd_sets') and contype = 'f'
               and confdeltype = 'c' and confrelid in (to_regclass('public.tenders'), to_regclass('public.vor_requests'))) = 2,
         'удаление тендера или заявки на ВОР удаляет и комплекты'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
