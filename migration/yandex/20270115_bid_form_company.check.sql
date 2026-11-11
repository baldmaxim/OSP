-- После 20270115_bid_form_company: анкета участника и «Моя компания» — одни сведения.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual from pg_policies
  where schemaname = 'public' and tablename = 'bid_company_answers'
),
col(name) as (
  select column_name::text from information_schema.columns where table_schema = 'public' and table_name = 'bid_form_fields'
),
checks(n, ok, what) as (
  select 1, (select count(*) from col where name in ('scope', 'source')) = 2
            and exists (select 1 from pg_constraint where conname = 'bid_form_fields_scope_check')
            and exists (select 1 from pg_constraint where conname = 'bid_form_fields_source_check')
            and to_regclass('public.bid_form_fields_source_key') is not null,
         'поля анкеты: вид (о компании / по тендеру) и связь с карточкой, одно сведение — одному полю'
  union all
  select 2, not exists (select 1 from public.bid_form_fields where source is not null and scope <> 'company'),
         'поле, связанное с карточкой, — всегда поле о компании'
  union all
  select 3, coalesce((select c.relrowsecurity and c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'bid_company_answers' and c.relkind = 'r'), false),
         'ответы о компании: таблица есть, правила по строкам включены и действуют на владельца'
  union all
  select 4, exists (select 1 from pol where policyname = 'osp_internal')
            and (select count(*) from pol where policyname <> 'osp_internal') = 1
            and exists (select 1 from pol where policyname = 'bid_company_answers_read' and cmd = 'SELECT'
                          and qual like '%role_in(%authenticated%' and qual like '%is_admin()%' and qual like '%osp_counterparty_id()%')
            and (select count(*) from osp_meta.policy_roles where schema_name = 'public' and table_name = 'bid_company_answers'
                 and roles = array['authenticated']) = 1,
         'читают только своя организация и администратор, записи через правила нет; запись о ролях политики'
  union all
  select 5, exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.bid_company_save(jsonb)')
                      and p.prosecdef and p.proconfig @> array['application_name=osp:internal']),
         'bid_company_save — служебная функция с отметкой'
  union all
  select 6, true,
         'связано с карточкой: ' || coalesce((select string_agg(source, ', ' order by sort_order) from public.bid_form_fields where source is not null), 'ничего')
           || '; полей о компании всего: ' || (select count(*) from public.bid_form_fields where scope = 'company')
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
