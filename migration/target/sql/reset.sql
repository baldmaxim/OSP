-- Возврат базы к пустой после репетиции (migration/target/reset.sh). Одна транзакция.
-- Убирает ровно то, что создал load.sh (перечень — osp_meta.manifest), и только если последняя
-- загрузка — репетиция. После настоящего переноса (final) — отказ всегда. Появилось что-то сверх
-- перечня — отказ: чужое не удаляем, разбираемся вручную.
-- Расширения (pg_trgm, pgcrypto) и схему public не трогает: ими управляет консоль Яндекса.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
-- Как при загрузке (load-end.sql): от search_path зависит запись типов в аргументах функций
-- («contracts» или «public.contracts»), а по ней сверяется перечень.
SET LOCAL search_path = '';
DO $reset$
DECLARE
  v_status text;
  v_rights text;
  v_role text;
  v_extra bigint;
  r record;
BEGIN
  IF to_regclass('osp_meta.load_log') IS NULL OR to_regclass('osp_meta.manifest') IS NULL THEN
    RAISE EXCEPTION 'OSP_RESET_NO_MARK';
  END IF;
  EXECUTE 'SELECT status, rights, runtime_role FROM osp_meta.load_log ORDER BY id DESC LIMIT 1' INTO v_status, v_rights, v_role;
  IF v_status IS DISTINCT FROM 'rehearsal' THEN
    RAISE EXCEPTION 'OSP_RESET_FINAL';
  END IF;

  EXECUTE $q$
    SELECT count(*) FROM (
      SELECT 'relation'::text, n.nspname::text, c.relname::text, c.relkind::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'auth') AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'c')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      UNION ALL
      SELECT 'function', n.nspname::text, p.proname::text, pg_get_function_identity_arguments(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public', 'auth')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      UNION ALL
      SELECT 'type', n.nspname::text, t.typname::text, t.typtype::text
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname IN ('public', 'auth') AND t.typtype IN ('e', 'd', 'r')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
      EXCEPT
      SELECT kind, schema, name, detail FROM osp_meta.manifest
    ) extra $q$ INTO v_extra;
  SELECT v_extra + count(*) INTO v_extra
  FROM pg_namespace
  WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public', 'auth', 'osp_meta', 'osp_private', 'osp_vault') AND nspname !~ '^pg_(toast|temp)';
  IF v_extra > 0 THEN
    RAISE EXCEPTION 'OSP_RESET_EXTRA %', v_extra;
  END IF;

  FOR r IN EXECUTE $q$ SELECT name, detail FROM osp_meta.manifest WHERE kind = 'relation' AND schema = 'public'
                       ORDER BY CASE detail WHEN 'v' THEN 1 WHEN 'm' THEN 2 WHEN 'r' THEN 3 WHEN 'p' THEN 3 WHEN 'S' THEN 4 ELSE 5 END $q$
  LOOP
    EXECUTE format('DROP %s IF EXISTS public.%I CASCADE',
      CASE r.detail WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'c' THEN 'TYPE' ELSE 'TABLE' END, r.name);
  END LOOP;
  FOR r IN EXECUTE $q$ SELECT name, detail FROM osp_meta.manifest WHERE kind = 'function' AND schema = 'public' $q$
  LOOP
    EXECUTE format('DROP ROUTINE IF EXISTS public.%I(%s) CASCADE', r.name, r.detail);
  END LOOP;
  FOR r IN EXECUTE $q$ SELECT name FROM osp_meta.manifest WHERE kind = 'type' AND schema = 'public' $q$
  LOOP
    EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.name);
  END LOOP;

  DROP SCHEMA auth CASCADE;
  -- Права под одну учётку (rights.sh): закрытая схема с материализованными представлениями и проверками.
  DROP SCHEMA IF EXISTS osp_private CASCADE;
  -- Учётные записи с отпечатками паролей (load.sh --auth). Адреса обложек (osp_meta.cover_moves) уходят
  -- вместе с osp_meta ниже.
  DROP SCHEMA IF EXISTS osp_vault CASCADE;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', v_role);
  END IF;
  -- Загрузка без прав снимала у будущих функций и типов право «всем» (load-lockdown.sql) — возвращаем.
  IF v_rights IN ('skipped', 'single') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON ROUTINES TO PUBLIC';
    EXECUTE 'ALTER DEFAULT PRIVILEGES GRANT USAGE ON TYPES TO PUBLIC';
  END IF;
  EXECUTE format('ALTER DATABASE %I RESET timezone', current_database());
  DROP SCHEMA osp_meta CASCADE;
END
$reset$;
COMMIT;
