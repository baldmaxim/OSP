-- База после загрузки без прав закрыта для обычных учёток кластера (migration/target/verify.sh).
-- Одна строка, семь чисел через табуляцию; все обязаны быть нулями:
--   политик; выдач на таблицы, представления и счётчики не владельцу; выдач на колонки; функций, которые
--   может вызвать «все» или кто-то кроме владельца; типов, открытых «всем»; выдач на схемы auth и
--   osp_meta не владельцу; недостающих запретов по умолчанию для будущих функций и типов (должно быть 2).
-- Только свои объекты: расширения, схему public и права на саму базу ведёт консоль Яндекса.
-- Только чтение.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = pg_catalog;
select
  (select count(*) from pg_policies where schemaname in ('public', 'auth', 'osp_meta'))
  || E'\t' || (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
               cross join lateral aclexplode(c.relacl) a
               where n.nspname in ('public', 'auth', 'osp_meta') and a.grantee <> c.relowner
                 and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'))
  || E'\t' || (select count(*) from pg_attribute t join pg_class c on c.oid = t.attrelid join pg_namespace n on n.oid = c.relnamespace
               where n.nspname in ('public', 'auth', 'osp_meta') and t.attacl is not null)
  || E'\t' || (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname in ('public', 'auth', 'osp_meta')
                 and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
                 and (has_function_privilege('public', p.oid, 'EXECUTE')
                      or exists (select 1 from aclexplode(p.proacl) a where a.grantee <> p.proowner)))
  || E'\t' || (select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace
               where n.nspname in ('public', 'auth', 'osp_meta') and t.typtype in ('e', 'd', 'r')
                 and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')
                 and has_type_privilege('public', t.oid, 'USAGE'))
  || E'\t' || (select count(*) from pg_namespace n cross join lateral aclexplode(n.nspacl) a
               where n.nspname in ('auth', 'osp_meta') and a.grantee <> n.nspowner)
  || E'\t' || (2 - (select count(*) from pg_default_acl da join pg_roles r on r.oid = da.defaclrole
                    where r.rolname = current_user and da.defaclnamespace = 0 and da.defaclobjtype in ('f', 'T')
                      and not exists (select 1 from aclexplode(da.defaclacl) a where a.grantee = 0)));
-- Справочно, не отказ: кто ещё может подключиться к базе и есть ли чужие сеансы.
select 'info' || E'\t'
  || (select count(*) from pg_roles r where r.rolcanlogin and not r.rolsuper and r.rolname <> current_user
        and has_database_privilege(r.oid, current_database(), 'CONNECT'))
  || E'\t' || (select count(*) from pg_stat_activity a join pg_roles r on r.oid = a.usesysid
               where a.datid = (select oid from pg_database where datname = current_database())
                 and a.pid <> pg_backend_pid() and r.rolname <> current_user and not r.rolsuper);
ROLLBACK;
