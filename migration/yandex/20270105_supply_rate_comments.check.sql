-- После 20270105_supply_rate_comments: комментарии к расценкам позиций снабжением — таблица, триггеры и права под
-- одну учётку. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename = 'tender_supply_comments'
),
trg as (
  select tg.tgname from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not tg.tgisinternal and c.relname = 'tender_supply_comments'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity and c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'tender_supply_comments' and c.relkind = 'r'), false),
         'комментарии: таблица есть, правила по строкам включены и действуют на владельца'
  union all
  select 2, exists (select 1 from pol where policyname = 'osp_internal')
            and (select count(*) from pol where policyname <> 'osp_internal' and qual || chk like '%role_in(%authenticated%') = 4
            and exists (select 1 from pol where cmd = 'SELECT' and policyname <> 'osp_internal' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where cmd in ('INSERT', 'UPDATE', 'DELETE') and policyname <> 'osp_internal'
                   and qual || chk like '%supply_can_edit()%') = 3,
         'пропуск служебных операций; читает сотрудник, пишет право правки «Тендеры» или «Тендеры на материалы»'
  union all
  select 3, (select count(*) from osp_meta.policy_roles where schema_name = 'public' and table_name = 'tender_supply_comments'
             and roles = array['authenticated']) = 4,
         'записи о ролях четырёх политик'
  union all
  select 4, (select count(*) from trg where tgname in ('tender_supply_comments_touch', 'tender_supply_comments_guard')) = 2,
         'триггеры «кто изменил» и закрытия после завершения тендера на материалы на месте'
  union all
  select 5, exists (select 1 from pg_attribute a where a.attrelid = 'public.tender_supply_comments'::regclass
                      and a.attname = 'material_key' and a.attgenerated = 's'),
         'ключ наименования вычисляется, как у цен'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
