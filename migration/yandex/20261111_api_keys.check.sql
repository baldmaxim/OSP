-- После 20261111_api_keys: ключи API для смежных систем и журнал вызовов — в закрытой схеме, только служебным
-- операциям osp-api. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой
-- служебной операции.
with
t as (
  select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'osp_private' and c.relname in ('api_keys', 'api_key_calls') and c.relkind = 'r'
),
checks(n, ok, what) as (
  select 1, (select count(*) from t) = 2,
         'ключи API и журнал вызовов — в закрытой схеме (osp_private.api_keys, osp_private.api_key_calls)'
  union all
  select 2, (select count(*) from t where relrowsecurity and relforcerowsecurity and relacl is null
               and (select count(*) from pg_policy p where p.polrelid = t.oid) = 1
               and exists (select 1 from pg_policy p where p.polrelid = t.oid and p.polname = 'osp_internal'
                             and pg_get_expr(p.polqual, p.polrelid) like '%osp_private.bypass()%'
                             and pg_get_expr(p.polwithcheck, p.polrelid) like '%osp_private.bypass()%')) = 2,
         'правила по строкам действуют и на владельца: только служебные операции (пропуск), выдач нет'
  union all
  select 3, not has_schema_privilege('public', 'osp_private', 'USAGE'),
         '«всем» закрытая схема недоступна'
  union all
  select 4, exists (select 1 from pg_constraint where conrelid = 'osp_private.api_keys'::regclass and contype = 'u'
                      and pg_get_constraintdef(oid) like '%(key_hash)%')
            and exists (select 1 from pg_constraint where conrelid = 'osp_private.api_keys'::regclass and contype = 'c'
                          and pg_get_constraintdef(oid) like '%key_hash%[0-9a-f]{64}%'),
         'отпечаток ключа — sha256 (64 знака), один на ключ; самого ключа в таблице нет'
  union all
  select 5, (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
             join pg_depend d on d.refobjid = c.oid and d.refclassid = 'pg_class'::regclass and d.classid = 'pg_rewrite'::regclass
             where n.nspname = 'osp_private' and c.relname in ('api_keys', 'api_key_calls')) = 0
            and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.prosrc ~ 'api_key') = 0,
         'ни представления, ни функции портала на ключи не ссылаются: читает только osp-api'
  union all
  select 6, exists (select 1 from pg_constraint where conrelid = 'osp_private.api_key_calls'::regclass and contype = 'f'
                      and confrelid = 'osp_private.api_keys'::regclass and confdeltype = 'c'),
         'журнал вызовов привязан к ключу (удаление строки ключа убирает и его журнал)'
  union all
  select 7, true,
         'ключей: ' || (select count(*) from osp_private.api_keys) || ', из настроек сервера osp-api занесёт сам при запуске'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
