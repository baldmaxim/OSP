-- Снимок кластера «что есть рядом с базой портала» (migration/target/neighbors.sh). ТОЛЬКО ЧТЕНИЕ:
-- системные каталоги в транзакции READ ONLY, в чужие базы скрипт не подключается.
-- Имена чужих баз и ролей наружу не идут — только их отпечатки (md5), номера и размеры.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SELECT 'db', md5(d.datname), d.oid, md5(pg_get_userbyid(d.datdba)),
       CASE WHEN has_database_privilege(d.oid, 'CONNECT') OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER')
            THEN pg_database_size(d.oid) END,
       (d.datname = current_database())::int
FROM pg_database d WHERE NOT d.datistemplate ORDER BY d.oid;
SELECT 'roles', count(*), md5(string_agg(rolname, ',' ORDER BY rolname)), '', '', '' FROM pg_roles WHERE rolname !~ '^pg_';
SELECT 'conn', (SELECT rolconnlimit FROM pg_roles WHERE rolname = current_user),
       (SELECT count(*) FROM pg_stat_activity WHERE usename = current_user AND pid <> pg_backend_pid()),
       (SELECT count(*) FROM pg_stat_activity WHERE usename = current_user AND datname = current_database() AND pid <> pg_backend_pid()), '', '';
ROLLBACK;
