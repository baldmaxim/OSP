-- Инвентаризация Supabase, запрос 3 из 4: пользователи и колонки-владельцы.
--
-- Только чтение: один SELECT, ничего не создаёт и не меняет.
-- ТОЛЬКО СЧЁТЧИКИ: ни email, ни id, ни хешей в ответе нет. Исключение — домены
-- почты сотрудников, если на домене не меньше 3 пользователей (это адрес
-- организации, а не человека) — чтобы понять, кто из сотрудников есть в ФОТ.
-- Колонки user_roles, которых может не быть (is_blocked и т. п.), читаются через
-- to_jsonb(строка), поэтому запрос не падает на непримененных миграциях.
-- Результат — одна ячейка JSON: скопируйте её целиком.
with
au as (
  select u.id,
         u.email,
         u.deleted_at,
         u.banned_until,
         u.email_confirmed_at,
         u.last_sign_in_at,
         coalesce(u.encrypted_password, '') as pwd,
         coalesce((to_jsonb(u) ->> 'is_sso_user')::boolean, false) as is_sso,
         coalesce((to_jsonb(u) ->> 'is_anonymous')::boolean, false) as is_anon
  from auth.users u
),
ur as (
  select r.user_id,
         r.role,
         r.is_approved,
         coalesce((to_jsonb(r) ->> 'is_blocked')::boolean, false) as is_blocked,
         (to_jsonb(r) ->> 'counterparty_id') is not null as is_contractor
  from public.user_roles r
),
prov as (
  select i.user_id, array_agg(distinct i.provider order by i.provider) as providers
  from auth.identities i group by i.user_id
),
owner_cols as (
  select c.table_name, c.column_name
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
  where c.table_schema = 'public' and c.data_type = 'uuid'
    and c.column_name ~ '(user|owner|author|creat|updat|assign|approv|manager|member|uploaded|applied|resp)'
),
owner_stats as (
  select oc.table_name, oc.column_name,
         (xpath('/row/nn/text()', x))[1]::text::bigint as non_null,
         (xpath('/row/users/text()', x))[1]::text::bigint as distinct_users,
         (xpath('/row/dangling/text()', x))[1]::text::bigint as dangling
  from owner_cols oc
  cross join lateral (
    select query_to_xml(format(
      'select count(t.%1$I) as nn, count(distinct t.%1$I) as users, '
      'count(*) filter (where t.%1$I is not null and not exists '
      '(select 1 from auth.users u where u.id = t.%1$I)) as dangling from public.%2$I t',
      oc.column_name, oc.table_name), false, true, '') as x
  ) q
)
select jsonb_build_object(
  'q', 'q3_users',
  'generated_at', now(),

  'auth_users', (
    select jsonb_build_object(
      'total', count(*),
      'deleted', count(*) filter (where deleted_at is not null),
      'banned', count(*) filter (where banned_until > now()),
      'unconfirmed', count(*) filter (where email_confirmed_at is null),
      'sso', count(*) filter (where is_sso),
      'anonymous', count(*) filter (where is_anon),
      'no_email', count(*) filter (where email is null),
      'bcrypt', count(*) filter (where pwd like '$2%'),
      'no_password', count(*) filter (where pwd = ''),
      'other_hash', count(*) filter (where pwd <> '' and pwd not like '$2%'),
      'signed_in_30d', count(*) filter (where last_sign_in_at > now() - interval '30 days'),
      'signed_in_180d', count(*) filter (where last_sign_in_at > now() - interval '180 days'),
      'never_signed_in', count(*) filter (where last_sign_in_at is null))
    from au),

  'providers', (
    select jsonb_object_agg(provider, n)
    from (select provider, count(*) as n from auth.identities group by provider) p),

  'duplicate_emails_ci', (
    select count(*) from (
      select lower(trim(email)) from au where email is not null group by 1 having count(*) > 1) d),

  'user_roles', (
    select jsonb_build_object(
      'total', count(*),
      'by_role', (select jsonb_object_agg(role, n) from (select role, count(*) n from ur group by role) x),
      'approved', count(*) filter (where is_approved),
      'not_approved', count(*) filter (where not is_approved),
      'blocked', count(*) filter (where is_blocked),
      'contractors', count(*) filter (where is_contractor),
      'employees', count(*) filter (where not is_contractor),
      'without_auth_user', count(*) filter (where not exists (select 1 from au where au.id = ur.user_id)))
    from ur),

  'auth_users_without_user_roles', (
    select count(*) from au where not exists (select 1 from ur where ur.user_id = au.id)),

  -- Как люди будут входить после окна B (подсказка для auth, решает она).
  'login_categories', (
    select jsonb_build_object(
      'employees_active', count(*) filter (where not ur.is_contractor and au.deleted_at is null),
      'contractors_active', count(*) filter (where ur.is_contractor and au.deleted_at is null),
      'employees_no_password', count(*) filter (where not ur.is_contractor and au.pwd = ''),
      'contractors_no_password', count(*) filter (where ur.is_contractor and au.pwd = ''),
      'non_email_provider_only', count(*) filter (
        where coalesce(prov.providers, '{}') <> '{}' and not ('email' = any(prov.providers))),
      'employees_signed_in_180d', count(*) filter (
        where not ur.is_contractor and au.last_sign_in_at > now() - interval '180 days'),
      'contractors_signed_in_180d', count(*) filter (
        where ur.is_contractor and au.last_sign_in_at > now() - interval '180 days'))
    from au
    join ur on ur.user_id = au.id
    left join prov on prov.user_id = au.id),

  -- Домены почты сотрудников (не подрядчиков), где не меньше 3 пользователей.
  'employee_email_domains', (
    select jsonb_object_agg(domain, n)
    from (
      select split_part(lower(trim(au.email)), '@', 2) as domain, count(*) as n
      from au join ur on ur.user_id = au.id
      where not ur.is_contractor and au.email is not null and au.deleted_at is null
      group by 1 having count(*) >= 3) d),

  -- Колонки-кандидаты во «владельцев»: заполненность, число разных id и «висячие» id
  -- (значения, которых нет в auth.users). Внешних ключей на auth.users в схеме нет.
  'owner_columns', (
    select jsonb_agg(jsonb_build_object(
             'col', table_name || '.' || column_name,
             'non_null', non_null, 'distinct', distinct_users, 'dangling', dangling)
           order by table_name, column_name)
    from owner_stats),

  'profile_tables', (
    select jsonb_agg(table_name)
    from information_schema.tables
    where table_schema = 'public' and table_name in ('profiles', 'users', 'user_profiles'))
)::text as inventory;
