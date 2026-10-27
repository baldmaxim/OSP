-- После 20261107_section_templates: шаблоны разделов — таблица, права под одну учётку и два шаблона.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename = 'section_templates'
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity and c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'section_templates' and c.relkind = 'r'), false),
         'шаблоны: таблица есть, правила по строкам включены и действуют на владельца'
  union all
  select 2, exists (select 1 from pol where policyname = 'osp_internal')
            and (select count(*) from pol where policyname <> 'osp_internal') = 1
            and exists (select 1 from pol where policyname = 'section_templates_read' and cmd = 'SELECT'
                          and qual like '%role_in(%authenticated%' and qual like '%osp_is_employee()%'),
         'пропуск служебных операций; читает сотрудник, правил записи нет'
  union all
  select 3, (select count(*) from osp_meta.policy_roles where schema_name = 'public' and table_name = 'section_templates'
             and roles = array['authenticated']) = 1,
         'запись о ролях политики чтения'
  union all
  select 4, (select count(*) from public.section_templates where code in ('tenders_concept_agreement', 'dc_was_became')) = 2,
         'шаблоны «Понятийное соглашение» и «Шаблон Было-Стало» заведены'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
