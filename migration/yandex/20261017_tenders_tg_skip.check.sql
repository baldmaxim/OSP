-- После 20261017_tenders_tg_skip: у tenders есть tg_skip / tg_skip_at / tg_skip_by и запрет
-- «опубликовано и не публиковать одновременно»; данные не тронуты.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
col as (
  select column_name, data_type, is_nullable, column_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'tenders' and column_name in ('tg_skip', 'tg_skip_at', 'tg_skip_by')
),
con as (
  select pg_get_constraintdef(c.oid) as def from pg_constraint c
  where c.conrelid = 'public.tenders'::regclass and c.conname = 'tenders_tg_state_check'
),
checks(n, ok, what) as (
  select 1, exists (select 1 from col where column_name = 'tg_skip' and data_type = 'boolean'
                    and is_nullable = 'NO' and column_default = 'false'),
         'tenders.tg_skip: boolean, NOT NULL, по умолчанию false'
  union all
  select 2, exists (select 1 from col where column_name = 'tg_skip_at' and data_type = 'timestamp with time zone')
            and exists (select 1 from col where column_name = 'tg_skip_by' and data_type = 'text'),
         'tenders.tg_skip_at (timestamptz) и tg_skip_by (text)'
  union all
  select 3, exists (select 1 from con where def ilike '%tg_published%tg_skip%'),
         'tenders: «опубликовано» и «не публиковать» одновременно запрещены (tenders_tg_state_check)'
  union all
  select 4, not exists (select 1 from public.tenders where tg_skip),
         'tenders: «не публиковать» ни у одного тендера — данные не изменились'
  union all
  select 5, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.tenders'::regclass),
         'tenders: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
