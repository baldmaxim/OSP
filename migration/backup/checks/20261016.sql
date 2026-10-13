-- Проверка после 20261016_public_tenders_view.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
with
v as (select 'public.public_open_tenders'::regclass as oid),
cols as (
  select array_agg(a.attname::text order by a.attnum) as names
  from pg_attribute a, v where a.attrelid = v.oid and a.attnum > 0 and not a.attisdropped
),
anon_policies as (
  select tablename, policyname from pg_policies
  where schemaname = 'public' and ('anon' = any (roles) or 'public' = any (roles))
),
expected as (
  select count(*) as n
  from public.tenders t join public.objects o on o.id = t.object_id
  where t.status::text = 'Идет тендерная процедура' and t.deleted_at is null
    and (t.tender_type is null or t.tender_type = 'main')
    and o.status in ('main_construction', 'warranty_service')
),
checks(n, ok, what) as (
  select 1, (select names from cols) = array['id', 'public_tender_number', 'work_description', 'start_date', 'end_date',
                                             'tender_start_date', 'tender_end_date', 'tender_package_link',
                                             'object_name', 'object_address', 'object_map_link'],
         'представление отдаёт только 11 публичных полей: ' || (select array_to_string(names, ', ') from cols)
  union all
  select 2, has_table_privilege('anon', (select oid from v), 'SELECT')
            and not has_table_privilege('anon', (select oid from v), 'INSERT')
            and not has_table_privilege('anon', (select oid from v), 'UPDATE')
            and not has_table_privilege('anon', (select oid from v), 'DELETE')
            and not has_table_privilege('authenticated', (select oid from v), 'UPDATE'),
         'представление: гостю и вошедшему — только чтение'
  union all
  select 3, (select reloptions @> array['security_barrier=true'] from pg_class, v where pg_class.oid = v.oid),
         'представление закрыто от подглядывания условием запроса (security_barrier)'
  union all
  select 4, not exists (select 1 from anon_policies where tablename in ('tenders', 'objects')),
         'у гостя нет политик чтения на tenders и objects'
  union all
  select 5, not exists (select 1 from anon_policies),
         'ни на одной таблице портала нет политик для гостя'
         || coalesce(' — остались: ' || (select string_agg(tablename || ' «' || policyname || '»', ', ' order by tablename) from anon_policies), '')
  union all
  select 6, (select count(*) from public.public_open_tenders) = (select n from expected),
         'открытых тендеров в представлении: ' || (select count(*) from public.public_open_tenders)
         || ', по условию отбора: ' || (select n from expected)
  union all
  select 7, (select relrowsecurity from pg_class where oid = 'public.tenders'::regclass)
            and (select relrowsecurity from pg_class where oid = 'public.objects'::regclass),
         'RLS на tenders и objects по-прежнему включён'
)
select case when ok then 'OK ' else 'FAIL ' end || what from checks order by n;
