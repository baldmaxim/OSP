-- Проверка после 20261017_tenders_tg_skip.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: колонка tg_skip читается, только если она есть (query_to_xml).
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
  select 4, case when not exists (select 1 from col where column_name = 'tg_skip') then false
                 else (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.tenders where tg_skip',
                   false, true, '')))[1]::text = '0' end,
         'tenders: «не публиковать» ни у одного тендера — данные не изменились'
  union all
  select 5, (select relrowsecurity from pg_class where oid = 'public.tenders'::regclass),
         'tenders: RLS по-прежнему включён'
  union all
  -- to_regclass: представления нет, пока не применена 20261016, — тогда и отдавать нечего.
  select 6, not exists (select 1 from pg_attribute
                        where attrelid = to_regclass('public.public_open_tenders') and attname like 'tg\_%'),
         'гостевое представление public_open_tenders не отдаёт отметки ТГ'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
