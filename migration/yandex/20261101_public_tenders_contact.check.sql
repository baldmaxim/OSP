-- После 20261101_public_tenders_contact: публичное представление public_open_tenders отдаёт прежние 11 полей и
-- ответственного (ФИО, телефон), читает таблицы только через закрытую схему, строки — гостю и вошедшему.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
v as (
  select c.oid, c.reloptions,
         coalesce((select o.option_value::boolean from pg_options_to_table(c.reloptions) o where o.option_name = 'security_invoker'), false) as invoker,
         regexp_replace(pg_get_viewdef(c.oid), '\s+', ' ', 'g') as def
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'public_open_tenders' and c.relkind = 'v'
),
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
got as (
  select count(*) as n,
         count(*) filter (where responsible_name is not null) as named,
         count(*) filter (where responsible_phone is not null) as phoned
  from public.public_open_tenders
),
checks(n, ok, what) as (
  select 1, (select names from cols) = array['id', 'public_tender_number', 'work_description', 'start_date', 'end_date',
                                             'tender_start_date', 'tender_end_date', 'tender_package_link',
                                             'object_name', 'object_address', 'object_map_link',
                                             'responsible_name', 'responsible_phone'],
         'представление отдаёт 11 публичных полей и ответственного (ФИО, телефон): ' || coalesce((select array_to_string(names, ', ') from cols), 'представления нет')
  union all
  select 2, exists (select 1 from v where not invoker and reloptions @> array['security_barrier=true']
                      and def like '%FROM osp_private.view_public_open_tenders()%'
                      and def like '%role_in(%anon%authenticated%'),
         'представление: таблицы — только через закрытую схему, строки — гостю и вошедшему (роль из токена), security_barrier'
  union all
  select 3, (select n from got) = (select n from expected),
         'открытых тендеров в представлении: ' || (select n from got) || ', по условию отбора: ' || (select n from expected)
  union all
  select 4, (select named from got) = (select named from expected) and (select phoned from got) = (select phoned from expected),
         'ответственный: ФИО у ' || (select named from got) || ' из ' || (select named from expected)
         || ', телефон у ' || (select phoned from got) || ' из ' || (select phoned from expected)
  union all
  select 5, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.contacts'::regclass)
            and not exists (select 1 from osp_meta.policy_roles where table_name = 'contacts' and 'anon' = any (roles)),
         'справочник contacts гостю закрыт: правила по строкам на месте, политик для гостя нет'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
