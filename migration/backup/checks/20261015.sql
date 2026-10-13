-- Проверка после 20261015_rates_registry_deterministic.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
with v(name) as (select unnest(array['kp_rates_registry', 'kp_rates_registry_filter_counterparties', 'kp_rates_registry_filter_objects', 'kp_rates_registry_filter_tenders', 'kp_rates_registry_units'])),
checks(n, ok, what) as (
  select 1, coalesce((select regexp_replace(definition, '\s+', ' ', 'g') ~ 'proposal_date DESC NULLS LAST, proposal_id' from pg_matviews where schemaname = 'public' and matviewname = 'kp_rates_registry_mv'), false),
         'при равных датах выбор строки закреплён идентификатором предложения'
  union all
  select 2, coalesce((select ispopulated from pg_matviews where schemaname = 'public' and matviewname = 'kp_rates_registry_mv'), false),
         'материализованное представление построено'
  union all
  select 3, (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'kp_rates_registry_mv') = 8
            and exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'kp_rates_registry_mv' and indexdef ~ 'UNIQUE'),
         'индексы на месте: 8, уникальный — есть'
  union all
  select 4, (select count(*) from v where to_regclass('public.' || name) is not null) = 5,
         'пять представлений реестра над ним на месте'
  union all
  select 5, to_regclass('public.kp_rates_registry_mv') is not null
            and not has_table_privilege('authenticated', to_regclass('public.kp_rates_registry_mv'), 'SELECT')
            and not has_table_privilege('anon', to_regclass('public.kp_rates_registry_mv'), 'SELECT')
            and has_table_privilege('service_role', to_regclass('public.kp_rates_registry_mv'), 'SELECT'),
         'материализованное представление напрямую читает только служебный ключ'
  union all
  select 6, (select bool_and(to_regclass('public.' || name) is not null
                             and has_table_privilege('authenticated', to_regclass('public.' || name), 'SELECT')
                             and not has_table_privilege('anon', to_regclass('public.' || name), 'SELECT')
                             and not has_table_privilege('authenticated', to_regclass('public.' || name), 'INSERT')) from v),
         'представления реестра: вошедшему — только чтение, анониму закрыты'
)
select case when ok then 'OK ' else 'FAIL ' end || what from checks order by n;
