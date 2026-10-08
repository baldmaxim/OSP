-- Инвентаризация Supabase, запрос 2 из 4: RLS, функции, права.
--
-- Только чтение: один SELECT, ничего не создаёт и не меняет.
-- Персональных данных и секретов в ответе нет: тексты политик и имена функций,
-- из настроек ролей — только имена параметров и значения таймаутов.
-- Результат — одна ячейка JSON: скопируйте её целиком.
select jsonb_build_object(
  'q', 'q2_security',
  'generated_at', now(),

  -- Все политики public.
  'policies', (
    select jsonb_agg(jsonb_build_object(
             't', tablename, 'name', policyname, 'permissive', permissive,
             'roles', roles, 'cmd', cmd, 'using', qual, 'check', with_check)
           order by tablename, policyname)
    from pg_policies where schemaname = 'public'),

  -- Политики для anon или public — их удаляем, а не переписываем.
  'anon_or_public_policies', (
    select jsonb_agg(jsonb_build_object('t', tablename, 'name', policyname, 'cmd', cmd)
           order by tablename, policyname)
    from pg_policies
    where schemaname = 'public' and roles && array['anon', 'public']::name[]),

  -- Политики «всё всем подтверждённым»: USING (true) для authenticated.
  'broad_authenticated_policies', (
    select jsonb_agg(jsonb_build_object('t', tablename, 'name', policyname, 'cmd', cmd)
           order by tablename, policyname)
    from pg_policies
    where schemaname = 'public' and 'authenticated' = any(roles)
      and coalesce(qual, 'true') = 'true'),

  -- Таблицы public без RLS.
  'tables_without_rls', (
    select jsonb_agg(c.relname order by c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),

  -- Функции public: SECURITY DEFINER, search_path, обращение к auth.*, кто может вызвать.
  'functions', (
    select jsonb_agg(jsonb_build_object(
             'fn', p.proname,
             'args', pg_get_function_identity_arguments(p.oid),
             'kind', p.prokind,
             'lang', l.lanname,
             'secdef', p.prosecdef,
             'volatility', p.provolatile,
             'search_path_set', coalesce(array_to_string(p.proconfig, ',') ~ 'search_path', false),
             'uses_auth', pg_get_functiondef(p.oid) ~ 'auth\.(uid|jwt|role|email)',
             'reads_auth_users', pg_get_functiondef(p.oid) ~ 'auth\.(users|identities)',
             'exec_public', exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                    where a.grantee = 0 and a.privilege_type = 'EXECUTE'),
             'exec_anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
             'exec_authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'))
           order by p.proname)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and p.prokind in ('f', 'p')
      -- функции расширений (pg_trgm и т. п.) не наши — пропускаем
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')),

  -- Что anon может читать или менять напрямую.
  'anon_table_privileges', (
    select jsonb_agg(jsonb_build_object(
             't', c.relname, 'kind', c.relkind,
             'select', has_table_privilege('anon', c.oid, 'SELECT'),
             'insert', has_table_privilege('anon', c.oid, 'INSERT'),
             'update', has_table_privilege('anon', c.oid, 'UPDATE'),
             'delete', has_table_privilege('anon', c.oid, 'DELETE'))
           order by c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
      and (has_table_privilege('anon', c.oid, 'SELECT')
           or has_table_privilege('anon', c.oid, 'INSERT')
           or has_table_privilege('anon', c.oid, 'UPDATE')
           or has_table_privilege('anon', c.oid, 'DELETE'))),

  -- Материализованные представления: RLS на них не действует, важно, кому выдан SELECT.
  'matview_select', (
    select jsonb_agg(jsonb_build_object(
             'mv', c.relname,
             'anon', has_table_privilege('anon', c.oid, 'SELECT'),
             'authenticated', has_table_privilege('authenticated', c.oid, 'SELECT')))
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'm'),

  -- Настройки ролей: имена параметров; значения — только у таймаутов.
  'role_settings', (
    select jsonb_agg(jsonb_build_object(
             'role', r.rolname,
             'keys', (select jsonb_agg(split_part(cfg, '=', 1)) from unnest(r.rolconfig) cfg),
             'timeouts', (select jsonb_object_agg(split_part(cfg, '=', 1), split_part(cfg, '=', 2))
                          from unnest(r.rolconfig) cfg
                          where split_part(cfg, '=', 1) ~ '(statement_timeout|lock_timeout|idle_in_transaction_session_timeout)')))
    from pg_roles r
    where r.rolname in ('anon', 'authenticated', 'authenticator', 'service_role', 'postgres')),

  -- Таблицы в публикации Realtime.
  'realtime_publication', (
    select jsonb_agg(tablename order by tablename)
    from pg_publication_tables where pubname = 'supabase_realtime')
)::text as inventory;
