-- Проверки перед загрузкой: только чтение. Каждая строка — «OK …» или «FAIL …»; при любом FAIL
-- load.sh не начинает загрузку. Имена чужих объектов не выводятся — только счётчики.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;

select case when current_setting('server_version_num')::int >= 170000 then 'OK' else 'FAIL' end
    || ' версия сервера — 17 или новее';

select case when d.datdba = r.oid then 'OK' else 'FAIL' end || ' роль подключения — владелец базы'
from pg_database d, pg_roles r
where d.datname = current_database() and r.rolname = current_user;

select case when exists (select 1 from pg_roles where rolname = :'runtime_role') then 'OK' else 'FAIL' end
    || ' роль приложения ' || :'runtime_role' || ' существует (создаётся пользователем в консоли Яндекса)';

select case when :'runtime_role' <> current_user
             and not coalesce((select rolsuper or rolbypassrls from pg_roles where rolname = :'runtime_role'), false)
             and not coalesce((select pg_has_role(:'runtime_role', current_user, 'MEMBER')
                               from pg_roles where rolname = :'runtime_role'), false)
            then 'OK' else 'FAIL' end
    || ' роль приложения — не владелец, не суперпользователь, не обходит RLS и не состоит в роли владельца';

select case when e.extname is not null then 'OK' else 'FAIL' end
    || ' расширение ' || x.name || ' включено (включается в консоли Яндекса)'
from (values ('pg_trgm', 1), ('pgcrypto', 2)) x(name, ord)
left join pg_extension e on e.extname = x.name
order by x.ord;

with rel as (
  select count(*) as n
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
    and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
), fn as (
  select count(*) as n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
), sch as (
  select count(*) as n from pg_namespace
  where nspname not in ('pg_catalog', 'information_schema', 'public') and nspname !~ '^pg_(toast|temp)'
)
select case when rel.n = 0 and fn.n = 0 and sch.n = 0 then 'OK база пустая'
            else 'FAIL база не пустая: таблиц и представлений — ' || rel.n || ', функций — ' || fn.n
                 || ', схем кроме public — ' || sch.n || ' (сначала reset.sh; чужое — разбираться вручную)' end
from rel, fn, sch;

ROLLBACK;
