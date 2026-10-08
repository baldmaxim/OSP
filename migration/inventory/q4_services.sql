-- Инвентаризация Supabase, запрос 4 из 4: cron, Storage, vault, применённые
-- миграции, кто подключается к базе.
--
-- Только чтение: один SELECT, ничего не создаёт и не меняет.
-- Секретов в ответе нет: у cron — имя и расписание (без текста команды, там бывают
-- ключи), у vault — только имена, у подключений — только счётчики.
-- Схем cron/vault/storage/supabase_migrations может не быть — тогда в ответе «нет».
-- Чтобы запрос не падал без них, обращение к ним идёт через query_to_xml: текст
-- запроса разбирается, только если объект существует.
-- Результат — одна ячейка JSON: скопируйте её целиком.
with dyn(key, guard, q) as (values
  ('cron_jobs', 'cron.job',
   $q$select coalesce(jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'active', active)
                               order by jobname), '[]'::jsonb)::text as j from cron.job$q$),
  ('vault_secret_names', 'vault.secrets',
   $q$select coalesce(jsonb_agg(name order by name), '[]'::jsonb)::text as j from vault.secrets$q$),
  ('storage_buckets', 'storage.buckets',
   $q$select coalesce(jsonb_agg(jsonb_build_object(
        'bucket', b.id, 'public', b.public,
        'objects', (select count(*) from storage.objects o where o.bucket_id = b.id),
        'bytes', (select coalesce(sum((o.metadata ->> 'size')::bigint), 0)
                  from storage.objects o where o.bucket_id = b.id)) order by b.id), '[]'::jsonb)::text as j
      from storage.buckets b$q$),
  ('applied_migrations', 'supabase_migrations.schema_migrations',
   $q$select coalesce(jsonb_agg(jsonb_build_object('version', to_jsonb(m) ->> 'version',
                                                   'name', to_jsonb(m) ->> 'name')
                               order by to_jsonb(m) ->> 'version'), '[]'::jsonb)::text as j
      from supabase_migrations.schema_migrations m$q$)
)
select jsonb_build_object(
  'q', 'q4_services',
  'generated_at', now(),

  'optional', (
    select jsonb_object_agg(key,
      case when to_regclass(guard) is null then to_jsonb('нет'::text)
           when not has_table_privilege(guard, 'SELECT') then to_jsonb('нет прав на чтение'::text)
      else convert_from(decode(
             (xpath('/row/j/text()', query_to_xml(
                format('select encode(convert_to(x.j, %L), %L) as j from (%s) x', 'UTF8', 'base64', q),
                false, true, '')))[1]::text,
             'base64'), 'UTF8')::jsonb
      end)
    from dyn),

  -- Кто сейчас подключён: нужно для барьера окна A (кого ждать и останавливать).
  'connections', (
    select jsonb_agg(jsonb_build_object(
             'user', usename, 'app', application_name, 'backend', backend_type,
             'state', state, 'n', n)
           order by n desc)
    from (
      select usename, application_name, backend_type, state, count(*) as n
      from pg_stat_activity
      where datname = current_database()
      group by 1, 2, 3, 4) a),

  'prepared_xacts', (select count(*) from pg_prepared_xacts),

  -- Самая долгая открытая транзакция сейчас (длительность, без текста запроса).
  'longest_open_xact', (
    select max(now() - xact_start)::text from pg_stat_activity
    where datname = current_database() and xact_start is not null and pid <> pg_backend_pid()),

  'replication_slots', (
    select jsonb_agg(jsonb_build_object('slot', slot_name, 'type', slot_type, 'active', active))
    from pg_replication_slots)
)::text as inventory;
