-- Инвентаризация Supabase, запрос 1 из 4: окружение и схема.
--
-- Только чтение: один SELECT, ничего не создаёт и не меняет.
-- Персональных данных в ответе нет — только имена объектов и счётчики.
-- Результат — одна ячейка JSON: скопируйте её целиком.
select jsonb_build_object(
  'q', 'q1_environment',
  'generated_at', now(),
  'version', version(),
  'server_version_num', current_setting('server_version_num'),
  'timezone', current_setting('TimeZone'),
  'db_size_bytes', pg_database_size(current_database()),
  'database', (
    select jsonb_build_object(
      'encoding', pg_encoding_to_char(d.encoding),
      'collate', d.datcollate,
      'ctype', d.datctype,
      'locale_provider', to_jsonb(d) -> 'datlocprovider',
      'icu_locale', coalesce(to_jsonb(d) -> 'datlocale', to_jsonb(d) -> 'daticulocale'))
    from pg_database d where d.datname = current_database()),

  'extensions', (
    select jsonb_agg(jsonb_build_object('name', e.extname, 'version', e.extversion, 'schema', n.nspname)
                     order by e.extname)
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace),

  -- Таблицы public: примерный объём, размер, PK, RLS, число пользовательских триггеров.
  'tables', (
    select jsonb_agg(jsonb_build_object(
             't', c.relname,
             'rows_est', coalesce(s.n_live_tup, 0),
             'bytes', pg_total_relation_size(c.oid),
             'pk', exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p'),
             'rls', c.relrowsecurity,
             'force_rls', c.relforcerowsecurity,
             'user_triggers', (select count(*) from pg_trigger tg where tg.tgrelid = c.oid and not tg.tgisinternal),
             'has_updated_at', exists (select 1 from pg_attribute a
                                       where a.attrelid = c.oid and a.attname = 'updated_at'
                                         and not a.attisdropped))
           order by c.relname)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_tables s on s.relid = c.oid
    where n.nspname = 'public' and c.relkind in ('r', 'p')),

  -- Представления: обычные и материализованные, ссылаются ли на auth.*, security_invoker.
  'views', (
    select jsonb_agg(jsonb_build_object(
             'v', c.relname,
             'kind', case c.relkind when 'm' then 'matview' else 'view' end,
             'uses_auth', pg_get_viewdef(c.oid) ~ 'auth\.',
             'options', c.reloptions)
           order by c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v', 'm')),

  -- Последовательности и к какой колонке привязаны (для переноса last_value/is_called).
  'sequences', (
    select jsonb_agg(jsonb_build_object(
             'seq', s.relname,
             'owned_by', (select t.relname || '.' || a.attname
                          from pg_depend dp
                          join pg_class t on t.oid = dp.refobjid
                          join pg_attribute a on a.attrelid = dp.refobjid and a.attnum = dp.refobjsubid
                          where dp.objid = s.oid and dp.deptype in ('a', 'i') limit 1))
           order by s.relname)
    from pg_class s join pg_namespace n on n.oid = s.relnamespace
    where n.nspname = 'public' and s.relkind = 'S'),

  -- Внешние ключи из public в чужие схемы (auth, storage и т. п.).
  'fk_to_other_schemas', (
    select jsonb_agg(jsonb_build_object('tbl', k.conrelid::regclass::text, 'name', k.conname,
                                        'def', pg_get_constraintdef(k.oid)))
    from pg_constraint k
    join pg_class src on src.oid = k.conrelid
    join pg_namespace sn on sn.oid = src.relnamespace
    join pg_class dst on dst.oid = k.confrelid
    join pg_namespace dn on dn.oid = dst.relnamespace
    where k.contype = 'f' and sn.nspname = 'public' and dn.nspname <> 'public'),

  -- DEFAULT, завязанные на auth.* или extensions.*.
  'defaults_auth_or_ext', (
    select jsonb_agg(jsonb_build_object('t', table_name, 'c', column_name, 'default', column_default))
    from information_schema.columns
    where table_schema = 'public' and column_default ~ '(auth|extensions)\.'),

  -- Триггеры на auth.users (их логика переедет в osp-api).
  'triggers_on_auth_users', (
    select jsonb_agg(jsonb_build_object('name', t.tgname, 'def', pg_get_triggerdef(t.oid)))
    from pg_trigger t
    where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal),

  -- Триггеры, которые зовут вебхуки (supabase_functions / pg_net).
  'webhook_triggers', (
    select jsonb_agg(jsonb_build_object('t', event_object_table, 'trigger', trigger_name))
    from information_schema.triggers
    where action_statement ~ '(supabase_functions|net\.)'),

  -- Типы колонок в public — для теста канонического хеша сверки.
  'column_types', (
    select jsonb_agg(distinct c.udt_name order by c.udt_name)
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = 'public'),

  -- Текстовые колонки с нестандартным collation.
  'non_default_collations', (
    select jsonb_agg(jsonb_build_object('t', table_name, 'c', column_name, 'collation', collation_name))
    from information_schema.columns
    where table_schema = 'public' and collation_name is not null),

  'enum_types', (
    select jsonb_agg(t.typname order by t.typname)
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype = 'e')
)::text as inventory;
