-- После 20261228_doc_check_created_guard: дату создания и автора заявки может менять только администратор.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
trg as (
  select pg_get_triggerdef(t.oid) def, t.tgenabled
  from pg_trigger t
  where t.tgrelid = 'public.doc_check_requests'::regclass and t.tgname = 'doc_check_requests_created_guard' and not t.tgisinternal
),
fn as (
  select p.prosecdef, p.proconfig, pg_get_functiondef(p.oid) def
  from pg_proc p
  where p.oid = 'public.doc_check_requests_created_guard()'::regprocedure
),
checks(n, ok, what) as (
  select 1, exists (select 1 from trg where tgenabled = 'O' and def like '%BEFORE UPDATE OF created_at, created_by_name%'),
         'триггер срабатывает на правку даты создания и автора'
  union all
  select 2, exists (select 1 from fn where not prosecdef and def like '%is_admin()%' and def like '%42501%'),
         'функция с правами вызывающего, отказ не администратору — 42501'
  union all
  select 3, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.doc_check_requests'::regclass),
         'doc_check_requests: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
