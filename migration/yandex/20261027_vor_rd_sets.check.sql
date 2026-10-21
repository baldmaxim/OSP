-- После 20261027_vor_rd_sets: комплекты РД в «ВОРах и РД» — таблица, триггер и права под одну учётку.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename = 'vor_rd_sets'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity and c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'vor_rd_sets' and c.relkind = 'r'), false),
         'комплекты РД: таблица есть, правила по строкам включены и действуют на владельца'
  union all
  select 2, exists (select 1 from pol where policyname = 'osp_internal')
            and (select count(*) from pol where policyname <> 'osp_internal' and qual || chk like '%role_in(%authenticated%') = 4
            and exists (select 1 from pol where cmd = 'SELECT' and policyname <> 'osp_internal' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where cmd in ('INSERT', 'UPDATE', 'DELETE') and policyname <> 'osp_internal'
                   and qual || chk like '%vor_rd_can_edit()%') = 3,
         'пропуск служебных операций; читает сотрудник, пишет право правки «Тендеры» или «ВОРы и РД»'
  union all
  select 3, (select count(*) from osp_meta.policy_roles where schema_name = 'public' and table_name = 'vor_rd_sets'
             and roles = array['authenticated']) = 4,
         'записи о ролях четырёх политик'
  union all
  select 4, exists (select 1 from pg_trigger tg where tg.tgrelid = 'public.vor_rd_sets'::regclass
                      and tg.tgname = 'vor_rd_sets_touch' and not tg.tgisinternal),
         'триггер «кто изменил» на месте'
  union all
  select 5, (select count(*) from pg_constraint where conrelid = 'public.vor_rd_sets'::regclass and contype = 'f'
               and confdeltype = 'c' and confrelid in ('public.tenders'::regclass, 'public.vor_requests'::regclass)) = 2
            and exists (select 1 from pg_constraint where conrelid = 'public.vor_rd_sets'::regclass
                          and conname = 'vor_rd_sets_owner_check'),
         'владелец — тендер или заявка на ВОР (ровно один), удаление владельца удаляет комплекты'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
