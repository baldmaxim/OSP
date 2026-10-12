-- Конец загрузки (та же транзакция): перечень созданного — по нему reset.sh отличит своё от чужого.
-- Имена указываем со схемой. search_path пустой — так же считает reset.sql: от него зависит запись
-- типов в аргументах функций («contracts» или «public.contracts»).
SELECT pg_catalog.set_config('search_path', '', true);
CREATE TABLE osp_meta.manifest AS
SELECT 'relation'::text AS kind, n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS detail
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'auth') AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'c')
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                  WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.deptype = 'e')
UNION ALL
SELECT 'function', n.nspname::text, p.proname::text, pg_catalog.pg_get_function_identity_arguments(p.oid)
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'auth')
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                  WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e')
UNION ALL
SELECT 'type', n.nspname::text, t.typname::text, t.typtype::text
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname IN ('public', 'auth') AND t.typtype IN ('e', 'd', 'r')
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                  WHERE d.classid = 'pg_catalog.pg_type'::pg_catalog.regclass AND d.objid = t.oid AND d.deptype = 'e');

UPDATE osp_meta.load_log SET finished_at = pg_catalog.now()
WHERE id = (SELECT pg_catalog.max(id) FROM osp_meta.load_log);
