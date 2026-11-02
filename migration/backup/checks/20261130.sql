-- Проверка после 20261130_cost_plan_calc_file_log.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: всё — через каталог.
with
tbl as (select to_regclass('public.cost_plan_calc_file_log') as rel),
trg as (
  select tg.oid, tg.tgenabled from pg_trigger tg
  where tg.tgrelid = to_regclass('public.s3_documents') and tg.tgname = 's3_documents_cost_plan_calc_log'
),
checks(n, ok, what) as (
  select 1, (select rel is not null from tbl)
            and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'cost_plan_calc_file_log'
                   and column_name in ('action', 'document_id', 'file_name', 'owner_type', 'owner_id', 'doc_category', 'object_name',
                                       'changed_by', 'changed_by_name', 'changed_at')) = 10,
         'журнал файлов «Расчёта ПЗ»: кто, когда, файл, объект'
  union all
  select 2, coalesce((select tgenabled = 'O' and pg_get_triggerdef(oid) like '%AFTER INSERT OR DELETE OR UPDATE OF doc_category, owner_type, owner_id%' from trg), false),
         'триггер на s3_documents включён: прикрепление, удаление, перенос'
  union all
  select 3, coalesce((select prosecdef from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                      where s.nspname = 'public' and p.proname = 'cost_plan_calc_file_log_write'), false),
         'функция триггера пишет журнал сама (пишущего права ни у кого нет)'
  union all
  select 4, coalesce((select relrowsecurity from pg_class, tbl where oid = tbl.rel), false)
            and coalesce((select has_table_privilege('authenticated', rel, 'select')
                            and not has_table_privilege('authenticated', rel, 'insert')
                            and not has_table_privilege('authenticated', rel, 'update')
                            and not has_table_privilege('authenticated', rel, 'delete')
                            and not has_table_privilege('anon', rel, 'select') from tbl), false),
         'журнал: сотруднику только чтение, анониму закрыто'
  union all
  select 5, not exists (select 1 from public.roles where key = 'economist')
            or exists (select 1 from public.role_permissions where role = 'economist' and section = 'cost_plan_docs' and can_edit),
         'экономист ОСП: право прикреплять документы расчёта ПЗ'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
