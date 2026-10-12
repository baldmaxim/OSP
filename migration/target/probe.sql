-- Разведка выданной базы PostgreSQL. Запускает migration/target/probe.sh; ТОЛЬКО ЧТЕНИЕ системных
-- каталогов, одна транзакция READ ONLY, в конце ROLLBACK. Ни DDL, ни записи данных здесь нет и быть не
-- должно — это проверяет tests/backup/target-probe.test.mjs.
--
-- Каждая строка ответа начинается с OK / ВНИМАНИЕ / FAIL / ИНФО. Имена базы и роли выводятся, только
-- если они из нашей заявки (migration/requests/cluster-owner.md). Чужие имена — баз, ролей, схем,
-- таблиц — не выводятся никогда, только счётчики: в кластере рядом лежат базы других порталов.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;

-- Таймауты роли читаем до того, как ограничим свою транзакцию.
select 'ИНФО таймауты роли: запрос — ' || current_setting('statement_timeout')
    || ', простой в транзакции — ' || current_setting('idle_in_transaction_session_timeout')
    || ', ожидание блокировки — ' || current_setting('lock_timeout')
    || ' (0 — без ограничения)';

SET LOCAL statement_timeout = '20s';
SET LOCAL lock_timeout = '2s';

select case
  when exists (select 1 from pg_namespace where nspname = 'auth')
       and (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) = 3
    then 'ИНФО это база Supabase: есть схема auth и роли anon / authenticated / service_role'
  else 'ИНФО это не Supabase: схемы auth с ролями anon / authenticated / service_role нет' end;

select case when current_setting('server_version_num')::int >= 170000 then 'OK' else 'FAIL' end
    || ' версия сервера: PostgreSQL ' || split_part(current_setting('server_version'), ' ', 1)
    || ' (в заявке — 17 или новее)';

select 'ИНФО база: ' || case current_database()
  when 'osp_stage_db' then 'osp_stage_db — СТЕНД данных портала'
  when 'osp_stage_ops_db' then 'osp_stage_ops_db — СТЕНД служебной базы'
  when 'osp_db' then 'osp_db — БОЕВАЯ база данных портала'
  when 'osp_ops_db' then 'osp_ops_db — БОЕВАЯ служебная база'
  when 'postgres' then 'postgres (имя по умолчанию)'
  else 'имя не из нашей заявки (не показываю)'
    || case when current_database() ~* 'osp' then '; в имени есть «osp»' else '; «osp» в имени нет' end
    || case when current_database() ~* '(stage|stand|test|dev|sandbox)' then '; по имени похожа на стенд'
            when current_database() ~* 'prod' then '; по имени похожа на боевую'
            else '; стенд или боевая — по имени не видно' end
  end;

-- current_user — тип name (63 байта): без ::text вся ветка CASE стала бы name и обрезала русский текст.
select 'ИНФО роль: ' || case
  when current_user in ('osp_migration', 'osp_runtime', 'osp_authenticator', 'osp_ro', 'osp_backup', 'postgres')
    then current_user::text
  else 'имя не из нашей заявки (не показываю)'
    || case when current_user ~* 'osp' then '; в имени есть «osp»' else '; «osp» в имени нет' end
  end
    || case when session_user <> current_user then ' (вход выполнен под другой ролью)' else '' end;

select 'ИНФО права роли: суперпользователь — ' || case when rolsuper then 'да' else 'нет' end
    || ', создаёт роли — ' || case when rolcreaterole then 'да' else 'нет' end
    || ', создаёт базы — ' || case when rolcreatedb then 'да' else 'нет' end
    || ', наследует права — ' || case when rolinherit then 'да' else 'нет' end
    || ', обходит RLS — ' || case when rolbypassrls then 'да' else 'нет' end
    || ', лимит соединений — ' || case when rolconnlimit < 0 then 'не задан' else rolconnlimit::text end
from pg_roles where rolname = current_user;

select 'ИНФО состоит в ролях: '
    || coalesce(string_agg(r.rolname, ', ' order by r.rolname) filter (where r.rolname ~ '^(mdb_|pg_|osp_)'), 'известных нет')
    || case when count(*) filter (where r.rolname !~ '^(mdb_|pg_|osp_)') > 0
            then '; ещё ' || count(*) filter (where r.rolname !~ '^(mdb_|pg_|osp_)') || ' (имена не показываю)'
            else '' end
from pg_auth_members m
join pg_roles r on r.oid = m.roleid
where m.member = (select oid from pg_roles where rolname = current_user);

select case when d.datdba = (select oid from pg_roles where rolname = current_user)
            then 'OK роль — владелец этой базы'
            else 'ВНИМАНИЕ роль не владелец этой базы' end
from pg_database d where d.datname = current_database();

select case when has_database_privilege(current_database(), 'CREATE')
            then 'OK роль может создавать схемы в базе'
            else 'ВНИМАНИЕ роль не может создавать схемы в базе' end;

select case
  when not exists (select 1 from pg_namespace where nspname = 'public') then 'ВНИМАНИЕ схемы public в базе нет'
  when has_schema_privilege('public', 'CREATE') then 'OK роль может создавать таблицы в схеме public'
  else 'ВНИМАНИЕ роль не может создавать таблицы в схеме public' end;

select case when pg_encoding_to_char(d.encoding) = 'UTF8' then 'OK' else 'FAIL' end
    || ' кодировка: ' || pg_encoding_to_char(d.encoding)
    || '; сортировка: ' || d.datcollate || ' / ' || d.datctype
    || '; поставщик: ' || case to_jsonb(d) ->> 'datlocprovider'
                            when 'i' then 'ICU ' || coalesce(to_jsonb(d) ->> 'datlocale', to_jsonb(d) ->> 'daticulocale', '')
                            when 'c' then 'libc'
                            when 'b' then 'builtin ' || coalesce(to_jsonb(d) ->> 'datlocale', '')
                            else 'не указан' end
    || ' (в заявке — UTF8, en_US.UTF-8, ICU)'
from pg_database d where d.datname = current_database();

select case when current_setting('TimeZone') in ('UTC', 'Etc/UTC') then 'OK' else 'ВНИМАНИЕ' end
    || ' часовой пояс: ' || current_setting('TimeZone') || ' (в заявке — UTC)';

select case
  when e.extname is not null then 'OK расширение ' || x.name || ': включено (схема ' || n.nspname || ')'
  when x.optional then 'ИНФО расширение ' || x.name || ': не включено (необязательное)'
  when a.name is not null then 'ВНИМАНИЕ расширение ' || x.name || ': доступно, но не включено — включает владелец кластера'
  else 'FAIL расширение ' || x.name || ': в кластере недоступно' end
from (values ('pg_trgm', 1, false), ('pgcrypto', 2, false), ('uuid-ossp', 3, false), ('pg_stat_statements', 4, true)) x(name, ord, optional)
left join pg_extension e on e.extname = x.name
left join pg_namespace n on n.oid = e.extnamespace
left join pg_available_extensions a on a.name = x.name
order by x.ord;

-- Что уже лежит в базе: без объектов расширений. Имена — только семь опорных таблиц портала.
with t as (
  select n.nspname, c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm')
    and n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname !~ '^pg_(toast|temp)'
    and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
), s as (
  select count(*) as total,
         count(*) filter (where nspname = 'public'
                            and relname in ('tenders', 'contracts', 'objects', 'counterparties', 'user_roles', 's3_documents', 'psdc')) as osp
  from t
)
select case
  when total = 0 then 'OK база пустая: таблиц и представлений нет'
  when osp > 0 then 'ИНФО в базе уже есть таблицы портала: ' || osp || ' из 7 опорных; всего таблиц и представлений — ' || total
  else 'ВНИМАНИЕ в базе есть таблицы, и это не таблицы портала: ' || total || ' (имена не показываю)' end
from s;

select 'ИНФО схем кроме служебных: ' || count(*)
    || case when bool_or(nspname = 'public') then ' (public есть)' else ' (public нет)' end
from pg_namespace
where nspname !~ '^pg_' and nspname <> 'information_schema';

select 'ИНФО размер базы: ' || pg_size_pretty(pg_database_size(current_database()));

select 'ИНФО других баз в кластере видно: ' || count(*) || ' (имена не показываю)'
from pg_database
where not datistemplate and datname <> current_database();

ROLLBACK;
