-- После 20270113_bid_vor_files: свой ВОР подрядчика с расценками — таблица, права под одну учётку, служебные функции.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename = 'tender_bid_files'
),
fns(sig) as (
  values ('public.bid_file_target(uuid,uuid)'), ('public.bid_file_save(uuid,uuid,text,text,text,bigint,jsonb)'),
         ('public.bid_file_remove(uuid)'), ('public.bid_file_get(uuid)'), ('public.bid_admin_overview()')
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity and c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'tender_bid_files' and c.relkind = 'r'), false),
         'файлы подрядчика: таблица есть, правила по строкам включены и действуют на владельца'
  union all
  select 2, exists (select 1 from pol where policyname = 'osp_internal')
            and (select count(*) from pol where policyname <> 'osp_internal') = 1
            and exists (select 1 from pol where policyname = 'tender_bid_files_read' and cmd = 'SELECT'
                          and qual like '%role_in(%authenticated%' and qual like '%is_admin()%' and qual like '%osp_counterparty_id()%'),
         'пропуск служебных операций; читают только своя организация и администратор, записи через правила нет'
  union all
  select 3, (select count(*) from osp_meta.policy_roles where schema_name = 'public' and table_name = 'tender_bid_files'
             and roles = array['authenticated']) = 1,
         'запись о ролях политики чтения'
  union all
  select 4, (select count(*) from fns join pg_proc p on p.oid = to_regprocedure(fns.sig)
             where p.prosecdef and p.proconfig @> array['application_name=osp:internal']) = 5,
         'bid_file_target / save / remove / get и сводка администратора — служебные функции с отметкой'
  union all
  select 5, (select pg_get_function_result('public.bid_file_get(uuid)'::regprocedure) = 'TABLE(s3_key text, file_name text)')
            and (select pg_get_function_result('public.bid_file_target(uuid,uuid)'::regprocedure) = 'TABLE(counterparty_id uuid, vor_name text)'),
         'функции отдают только ключ и имя файла, организацию и имя ведомости'
  union all
  select 6, (select prosrc like '%tender_bid_files%' from pg_proc where oid = 'public.bid_admin_overview()'::regprocedure)
            and (select pg_get_function_result('public.bid_admin_overview()'::regprocedure) like 'TABLE(tender_id uuid, %, updated_at timestamp with time zone)'),
         'сводка администратора: прежние поля, в неё попадают и организации только с файлами'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
