-- Загрузка без прав (load.sh --without-rights, та же транзакция): «без прав» значит «закрыто», а не
-- «открыто». Таблицы, представления и счётчики без выданных прав и так доступны только владельцу.
-- Но PostgreSQL по умолчанию разрешает «всем» (PUBLIC) вызывать функции и пользоваться типами — в общем
-- кластере это любая учётка, которой открыто подключение к базе. Поэтому:
--   1) у своих функций и типов право «всем» снимается;
--   2) для будущих функций и типов этой учётки в ЭТОЙ базе право «всем» не выдаётся
--      (pg_default_acl — каталог базы, на другие базы той же учётки не действует).
-- Объекты расширений (pg_trgm, pgcrypto), схему public и права на саму базу не трогаем: ими управляет
-- консоль Яндекса. reset.sh возвращает права по умолчанию (sql/reset.sql).
DO $lock$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS routine
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'auth')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON ROUTINE %s FROM PUBLIC', r.routine);
  END LOOP;
  FOR r IN
    SELECT t.oid::pg_catalog.regtype AS typ
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname IN ('public', 'auth') AND t.typtype IN ('e', 'd', 'r')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_type'::pg_catalog.regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON TYPE %s FROM PUBLIC', r.typ);
  END LOOP;
END
$lock$;

ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON ROUTINES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE USAGE ON TYPES FROM PUBLIC;
