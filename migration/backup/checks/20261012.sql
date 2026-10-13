-- После 20261012: в пути к Larix.CPM (contracts.document_link) не осталось путей к папкам,
-- четыре договора из решения пользователя на месте, ссылки на Larix не тронуты.
-- Строки «OK …» / «FAIL …»; только чтение.
with
four as (
  select display_id, document_link from public.contracts where display_id in (87, 91, 331, 334)
),
live as (
  select display_id, document_link from public.contracts where deleted_at is null
),
not_link as (
  select display_id from live
  where document_link is not null and btrim(document_link) <> '' and document_link !~* '^\s*https?://'
),
checks(n, ok, what) as (
  select 1, (select count(*) from four) = 4,
         'договоры ID 87, 91, 331, 334 на месте: ' || (select count(*) from four) || ' из 4'
  union all
  select 2, not exists (select 1 from four where document_link is not null and document_link !~* '^\s*https?://'),
         'у них в пути к Larix.CPM нет пути к папке'
         || coalesce(' — остался у ID ' || (select string_agg(display_id::text, ', ' order by display_id)
                                            from four where document_link is not null
                                                        and document_link !~* '^\s*https?://'), '')
  union all
  select 3, not exists (select 1 from not_link),
         'в действующих договорах нет значений, не похожих на ссылку'
         || coalesce(' — есть у ID ' || (select string_agg(display_id::text, ', ' order by display_id) from not_link), '')
  union all
  select 4, (select count(*) from live where document_link ~* '^\s*https?://') >= 225,
         'договоров со ссылкой на Larix: ' || (select count(*) from live where document_link ~* '^\s*https?://')
         || ' (на копии от 12.10.2026 было 225)'
  union all
  select 5, coalesce(col_description('public.contracts'::regclass,
                       (select attnum from pg_attribute
                        where attrelid = 'public.contracts'::regclass and attname = 'document_link')), '')
            like 'Путь к Larix.CPM%',
         'contracts.document_link описана как путь к Larix.CPM'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
