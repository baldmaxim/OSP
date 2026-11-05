-- После 20261220_tender_counterparties_updated_at: у участников тендера есть отметка времени, её ставит триггер;
-- строки на месте, правила по строкам прежние. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh).
with
checks(n, ok, what) as (
  select 1, exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'tender_counterparties'
                      and column_name = 'updated_at' and data_type = 'timestamp with time zone' and is_nullable = 'NO'),
         'tender_counterparties: updated_at (timestamptz, not null)'
  union all
  select 2, exists (select 1 from pg_trigger
                    where tgrelid = 'public.tender_counterparties'::regclass and not tgisinternal
                      and tgname = 'trigger_update_tender_counterparties_updated_at' and tgenabled = 'O'),
         'триггер отметки времени включён'
  union all
  select 3, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.tender_counterparties'::regclass),
         'tender_counterparties: RLS включён и действует на владельца'
  union all
  select 4, not exists (select 1 from pg_proc p
                        join pg_trigger t on t.tgfoid = p.oid
                        where t.tgrelid = 'public.tender_counterparties'::regclass
                          and t.tgname = 'trigger_update_tender_counterparties_updated_at' and p.prosecdef),
         'функция триггера без повышенных прав'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
