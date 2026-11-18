-- После 20270217_tenders_restart_link: у тендера — ссылка на тендер, которым он перезапущен; данные не тронуты.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
col as (
  select data_type, is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 'tenders' and column_name = 'restarted_by_tender_id'
),
fk as (
  select pg_get_constraintdef(oid) as def from pg_constraint
  where conrelid = 'public.tenders'::regclass and conname = 'tenders_restarted_by_tender_id_fkey' and contype = 'f'
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where data_type = 'uuid' and is_nullable = 'YES'),
         'tenders.restarted_by_tender_id: uuid, может быть пустым'
  union all
  select 2, coalesce((select def like '%REFERENCES tenders(id)%' and def like '%ON DELETE SET NULL%' from fk), false),
         'ссылка — на тендер, при его удалении пустеет (ON DELETE SET NULL)'
  union all
  select 3, exists (select 1 from pg_constraint where conrelid = 'public.tenders'::regclass
                      and conname = 'tenders_restarted_by_not_self' and contype = 'c'),
         'тендер не может быть перезапуском самого себя'
  union all
  select 4, exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'tenders'
                      and indexname = 'idx_tenders_restarted_by_tender_id'),
         'индекс по ссылке на новый тендер'
  union all
  select 5, not exists (select 1 from public.tenders where restarted_by_tender_id is not null),
         'tenders: ссылок ещё нет — данные не изменились'
  union all
  select 6, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.tenders'::regclass),
         'tenders: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
