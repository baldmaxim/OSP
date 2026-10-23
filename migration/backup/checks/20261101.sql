-- Проверка после 20261101_public_tenders_contact.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
with
v as (select 'public.public_open_tenders'::regclass as oid),
cols as (
  select array_agg(a.attname::text order by a.attnum) as names
  from pg_attribute a, v where a.attrelid = v.oid and a.attnum > 0 and not a.attisdropped
),
expected as (
  select count(*) as n,
         count(*) filter (where nullif(btrim(c.full_name::text), '') is not null) as named,
         count(*) filter (where nullif(btrim(c.phone::text), '') is not null) as phoned
  from public.tenders t
    join public.objects o on o.id = t.object_id
    left join public.contacts c on c.id = t.responsible_contact_id
  where t.status::text = 'Идет тендерная процедура' and t.deleted_at is null
    and (t.tender_type is null or t.tender_type = 'main')
    and o.status in ('main_construction', 'warranty_service')
),
-- to_jsonb: до миграции колонок ответственного нет — проверка отвечает FAIL, а не ошибкой.
got as (
  select count(*) as n,
         count(*) filter (where to_jsonb(p) ->> 'responsible_name' is not null) as named,
         count(*) filter (where to_jsonb(p) ->> 'responsible_phone' is not null) as phoned
  from public.public_open_tenders p
),
checks(n, ok, what) as (
  select 1, (select names from cols) = array['id', 'public_tender_number', 'work_description', 'start_date', 'end_date',
                                             'tender_start_date', 'tender_end_date', 'tender_package_link',
                                             'object_name', 'object_address', 'object_map_link',
                                             'responsible_name', 'responsible_phone'],
         'представление отдаёт 11 публичных полей и ответственного (ФИО, телефон): ' || (select array_to_string(names, ', ') from cols)
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
  select 4, (select n from got) = (select n from expected),
         'открытых тендеров в представлении: ' || (select n from got) || ', по условию отбора: ' || (select n from expected)
         || ' — тендер без ответственного не пропал'
  union all
  select 5, (select named from got) = (select named from expected) and (select phoned from got) = (select phoned from expected),
         'ответственный: ФИО у ' || (select named from got) || ' из ' || (select named from expected)
         || ', телефон у ' || (select phoned from got) || ' из ' || (select phoned from expected)
  union all
  select 6, not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contacts'
                          and ('anon' = any (roles) or 'public' = any (roles)))
            and (select relrowsecurity from pg_class where oid = 'public.contacts'::regclass),
         'справочник contacts гостю закрыт: RLS включён, политик для гостя нет'
)
select case when ok then 'OK ' else 'FAIL ' end || what from checks order by n;
