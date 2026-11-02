-- После 20261130_cost_plan_calc_file_log: журнал файлов «Расчёта ПЗ» пишет только служебный триггер, читает сотрудник;
-- право cost_plan_docs у экономиста ОСП; уже прикреплённые файлы — в журнале. Строки «OK …» / «FAIL …»; выполняется в
-- транзакции миграции (migrate.sh), с отметкой служебной операции.
with
cats(c) as (values ('cost_plan_calc'), ('cost_plan_direct_costs'), ('cost_plan_kp_before_transfers')),
checks(n, ok, what) as (
  select 1, (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'cost_plan_calc_file_log'
               and column_name in ('action', 'document_id', 'file_name', 'owner_type', 'owner_id', 'doc_category', 'object_name',
                                   'changed_by', 'changed_by_name', 'changed_at')) = 10
            and not exists (select 1 from pg_constraint where conrelid = 'public.cost_plan_calc_file_log'::regclass and contype = 'f'),
         'журнал: кто, когда, файл, объект; внешних ключей нет — запись переживает файл и объект'
  union all
  select 2, (select tgenabled = 'O' and pg_get_triggerdef(tg.oid) like '%AFTER INSERT OR DELETE OR UPDATE OF doc_category, owner_type, owner_id%'
             from pg_trigger tg where tg.tgrelid = 'public.s3_documents'::regclass and tg.tgname = 's3_documents_cost_plan_calc_log'),
         'триггер на s3_documents включён: прикрепление, удаление, перенос'
  union all
  select 3, (select prosecdef and proconfig @> array['application_name=osp:internal'] from pg_proc
             where oid = 'public.cost_plan_calc_file_log_write()'::regprocedure),
         'функция триггера — служебная, с отметкой пропуска'
  union all
  select 4, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.cost_plan_calc_file_log'::regclass)
            and (select array_agg(policyname::text order by policyname) = array['cost_plan_calc_file_log_read', 'osp_internal']
                 from pg_policies where schemaname = 'public' and tablename = 'cost_plan_calc_file_log')
            and (select cmd = 'SELECT' from pg_policies where schemaname = 'public' and tablename = 'cost_plan_calc_file_log'
                   and policyname = 'cost_plan_calc_file_log_read'),
         'правила по строкам: читать — сотруднику, писать — только служебной операции'
  union all
  select 5, not exists (select 1 from public.roles where key = 'economist')
            or exists (select 1 from public.role_permissions where role = 'economist' and section = 'cost_plan_docs' and can_edit),
         'экономист ОСП: право прикреплять документы расчёта ПЗ'
  union all
  select 6, not exists (select 1 from public.s3_documents d join cats on cats.c = d.doc_category
                        where not exists (select 1 from public.cost_plan_calc_file_log l where l.document_id = d.id and l.action = 'attach')),
         'все уже прикреплённые файлы — в журнале'
)
select case when ok is true then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
