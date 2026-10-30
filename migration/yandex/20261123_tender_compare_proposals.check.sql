-- После 20261123_tender_compare_proposals: все КП тендера одним запросом — функция с правами вызывающего (правила
-- по строкам действуют, служебной отметки нет), STABLE, ответ {"coverage", "rows"}; правила таблицы на месте.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
fn as (
  select p.oid, p.prosecdef, p.provolatile, pg_get_function_result(p.oid) as result,
         coalesce(p.proconfig::text, '') ~ 'application_name=osp:internal' as marked
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tender_compare_proposals'
    and pg_get_function_identity_arguments(p.oid) = 'p_tender uuid'
),
answer as (
  select public.tender_compare_proposals('00000000-0000-0000-0000-000000000000')::jsonb as v
),
checks(n, ok, what) as (
  select 1, coalesce((select result = 'json' and not prosecdef and not marked and provolatile = 's' from fn), false),
         'tender_compare_proposals(uuid): json, права вызывающего, без отметки пропуска, STABLE'
  union all
  select 2, (select v ? 'coverage' and v -> 'rows' = '[]'::jsonb from answer),
         'ответ: пометка «учтено» есть / нет и строки КП (у тендера без КП — пусто)'
  union all
  select 3, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.tender_counterparty_proposals'::regclass),
         'tender_counterparty_proposals: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
