-- «Отпечаток» прав для test:db (основа Р2). Создаётся ТОЛЬКО во временной базе — копии
-- прода в Docker (migration/backup/restore-copy.sh). Наружу отдаёт только признаки:
-- видит ли класс пользователей все / часть / ни одной строки и может ли вставить,
-- изменить, удалить строку. Ни строк, ни id, ни имён.
--
-- Каждое действие выполняется во вложенной транзакции под ролью класса (SET LOCAL ROLE +
-- claims, как ставит PostgREST) и откатывается вместе со сменой роли и настройками.

CREATE SCHEMA IF NOT EXISTS osp_test;

-- Классы пользователей. Синтетические учётки: фиксированные id, адреса @example.invalid.
CREATE TABLE IF NOT EXISTS osp_test.users (
  class        text PRIMARY KEY,
  id           uuid,          -- NULL — без входа (anon, service_role)
  db_role      text NOT NULL, -- роль PostgREST: authenticated / anon / service_role
  app_role     text,          -- user_roles.role; NULL — строки в user_roles нет
  approved     boolean,
  blocked      boolean,
  with_org     boolean        -- подрядчик своей организации
);

CREATE OR REPLACE FUNCTION osp_test.setup(p_sections text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_cp uuid;
  u record;
BEGIN
  TRUNCATE osp_test.users;
  INSERT INTO osp_test.users VALUES
    ('admin',            '00000000-0000-4000-8000-0000000000a1', 'authenticated', 'admin',         true,  false, false),
    ('employee_full',    '00000000-0000-4000-8000-0000000000a2', 'authenticated', 'osp_test_full', true,  false, false),
    ('employee_none',    '00000000-0000-4000-8000-0000000000a3', 'authenticated', 'osp_test_none', true,  false, false),
    ('vors_only',        '00000000-0000-4000-8000-0000000000a4', 'authenticated', 'osp_test_vors', true,  false, false),
    ('contractor_own',   '00000000-0000-4000-8000-0000000000a5', 'authenticated', 'contractor',    true,  false, true),
    ('contractor_noorg', '00000000-0000-4000-8000-0000000000a6', 'authenticated', 'contractor',    true,  false, false),
    ('unapproved',       '00000000-0000-4000-8000-0000000000a7', 'authenticated', 'engineer',      false, false, false),
    ('blocked',          '00000000-0000-4000-8000-0000000000a8', 'authenticated', 'engineer',      false, true,  false),
    ('no_user_roles',    '00000000-0000-4000-8000-0000000000a9', 'authenticated', NULL,            NULL,  NULL,  false),
    ('anon',             NULL,                                   'anon',          NULL,            NULL,  NULL,  false),
    ('service_role',     NULL,                                   'service_role',  NULL,            NULL,  NULL,  false);

  -- Тестовые роли портала и права разделов (как в «Администрировании»).
  INSERT INTO public.roles (key, label, is_system) VALUES
    ('osp_test_full', 'Тест: все разделы', false),
    ('osp_test_none', 'Тест: без разделов', false),
    ('osp_test_vors', 'Тест: только ВОРы и РД', false)
  ON CONFLICT (key) DO NOTHING;
  DELETE FROM public.role_permissions WHERE role LIKE 'osp_test_%';
  INSERT INTO public.role_permissions (role, section, can_view, can_edit)
    SELECT 'osp_test_full', s, true, true FROM unnest(p_sections) s;
  INSERT INTO public.role_permissions (role, section, can_view, can_edit) VALUES ('osp_test_vors', 'vors', true, true);

  -- Организация подрядчика — контрагент с наибольшим числом участий в тендерах (детерминированно).
  SELECT counterparty_id INTO v_cp
  FROM public.tender_counterparties
  GROUP BY counterparty_id ORDER BY count(*) DESC, counterparty_id LIMIT 1;

  FOR u IN SELECT * FROM osp_test.users WHERE id IS NOT NULL LOOP
    INSERT INTO auth.users (id, aud, role, email, email_confirmed_at, created_at)
    VALUES (u.id, 'authenticated', 'authenticated', u.class || '@example.invalid', now(), now())
    ON CONFLICT (id) DO NOTHING;
    IF u.app_role IS NOT NULL THEN
      INSERT INTO public.user_roles (user_id, role, is_approved, is_blocked, email, full_name, counterparty_id)
      VALUES (u.id, u.app_role, u.approved, u.blocked, u.class || '@example.invalid', 'Тест ' || u.class,
              CASE WHEN u.with_org THEN v_cp END)
      ON CONFLICT (user_id) DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- Выполнить SQL под ролью класса во вложенной транзакции и откатить её.
-- p_mode 'value' — вернуть значение запроса, 'count' — число затронутых строк.
-- Ответ: 'ok:<значение>' или 'err:<SQLSTATE>'.
CREATE OR REPLACE FUNCTION osp_test.try_as(p_class text, p_mode text, p_sql text,
                                           p_ctid tid DEFAULT NULL, p_row jsonb DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  u osp_test.users%ROWTYPE;
  v_out text;
  n bigint;
  v_state text;
  v_detail text;
BEGIN
  SELECT * INTO u FROM osp_test.users WHERE class = p_class;
  BEGIN
    PERFORM set_config('request.jwt.claims',
      CASE WHEN u.id IS NULL THEN json_build_object('role', u.db_role)::text
           ELSE json_build_object('sub', u.id, 'role', u.db_role, 'aud', 'authenticated',
                                  'email', u.class || '@example.invalid')::text END, true);
    PERFORM set_config('request.jwt.claim.sub', coalesce(u.id::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', u.db_role, true);
    -- Таймауты ролей как на проде (q2): authenticated 30 с, anon 3 с.
    PERFORM set_config('statement_timeout',
      CASE u.db_role WHEN 'anon' THEN '3s' WHEN 'authenticated' THEN '30s' ELSE '0' END, true);
    EXECUTE format('SET LOCAL ROLE %I', u.db_role);
    IF p_mode = 'value' THEN
      EXECUTE p_sql INTO v_out USING p_ctid, p_row;
    ELSE
      EXECUTE p_sql USING p_ctid, p_row;
      GET DIAGNOSTICS n = ROW_COUNT;
      v_out := n::text;
    END IF;
    RAISE EXCEPTION 'osp_test rollback' USING ERRCODE = 'OSP01', DETAIL = coalesce(v_out, '');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
    IF v_state = 'OSP01' THEN RETURN 'ok:' || v_detail; END IF;
    RETURN 'err:' || v_state;
  END;
END $$;

-- Результат записи: yes — RLS пропустил (в т. ч. упёрлись в уникальность или FK: 23xxx),
-- no — отказ (42501 или 0 затронутых строк), err:<код> — иное (триггер, таймаут).
CREATE OR REPLACE FUNCTION osp_test.write_verdict(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p LIKE 'ok:%' THEN CASE WHEN substr(p, 4)::bigint > 0 THEN 'yes' ELSE 'no' END
    WHEN p = 'err:42501' THEN 'no'
    WHEN p LIKE 'err:23%' THEN 'yes'
    ELSE p END
$$;

CREATE OR REPLACE FUNCTION osp_test.fingerprint(p_class text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  r record;
  res jsonb := '{}'::jsonb;
  item jsonb;
  v_total bigint;
  v_sel text;
  v_ctid tid;
  v_row jsonb;
  v_cols text;
  v_vals text;
  v_upd_col text;
  v_visible_ctid text;
  v_ins text;
  v_key_col text;
  v_key_uuid boolean;
  v_key text;
  v_row_text text;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname, c.relkind
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND NOT c.relispartition
    ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.relname) INTO v_total;

    -- Чтение: сколько строк видит класс.
    v_sel := osp_test.try_as(p_class, 'value', format('SELECT count(*)::text FROM public.%I', r.relname));
    item := jsonb_build_object('select', CASE
      WHEN v_sel NOT LIKE 'ok:%' THEN v_sel
      -- Представление, строки которого зависят от пользователя (суперпользователь без JWT видит 0).
      WHEN v_total = 0 AND r.relkind = 'v' AND substr(v_sel, 4)::bigint > 0 THEN 'visible'
      WHEN v_total = 0 THEN 'empty'
      WHEN substr(v_sel, 4)::bigint = 0 THEN 'none'
      WHEN substr(v_sel, 4)::bigint >= v_total THEN 'all'
      ELSE 'some' END);

    IF r.relkind IN ('r', 'p') AND v_total > 0 THEN
      -- Строка-образец: первая видимая классу, иначе первая в таблице.
      v_visible_ctid := osp_test.try_as(p_class, 'value',
        format('SELECT ctid::text FROM public.%I ORDER BY ctid LIMIT 1', r.relname));
      IF v_visible_ctid LIKE 'ok:_%' THEN
        v_ctid := substr(v_visible_ctid, 4)::tid;
      ELSE
        EXECUTE format('SELECT ctid FROM public.%I ORDER BY ctid LIMIT 1', r.relname) INTO v_ctid;
      END IF;
      EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE ctid = $1', r.relname) INTO v_row USING v_ctid;

      -- Вставка: копия строки-образца; столбцы PK с DEFAULT берут новое значение, uuid-PK без
      -- DEFAULT — новый gen_random_uuid(); генерируемые и identity-столбцы пропускаются.
      SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
             string_agg(CASE WHEN pk.is_pk AND a.atttypid = 'uuid'::regtype THEN 'gen_random_uuid()'
                             ELSE 'x.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum)
        INTO v_cols, v_vals
      FROM pg_attribute a
      LEFT JOIN LATERAL (
        SELECT true AS is_pk FROM pg_index i
        WHERE i.indrelid = r.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)
      ) pk ON true
      LEFT JOIN pg_attrdef d ON d.adrelid = r.oid AND d.adnum = a.attnum
      WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attgenerated = '' AND a.attidentity = ''
        AND NOT (coalesce(pk.is_pk, false) AND d.oid IS NOT NULL);
      IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE i.indrelid = r.oid AND i.indisprimary AND d.oid IS NULL AND a.atttypid <> 'uuid'::regtype) THEN
        v_ins := 'n/a';  -- PK без DEFAULT и не uuid: новую строку не построить
      ELSE
        v_ins := osp_test.write_verdict(osp_test.try_as(p_class, 'count',
          format('INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $2) x',
                 r.relname, v_cols, v_vals, r.relname), NULL, v_row));
      END IF;

      -- Изменение строки самой в себя (первый столбец PK, иначе первый столбец) и удаление.
      SELECT a.attname INTO v_upd_col
      FROM pg_attribute a
      LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)
      WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      ORDER BY (i.indexrelid IS NULL), a.attnum LIMIT 1;

      item := item
        || jsonb_build_object('insert', v_ins)
        || jsonb_build_object('update', osp_test.write_verdict(osp_test.try_as(p_class, 'count',
             format('UPDATE public.%I SET %I = %I WHERE ctid = $1', r.relname, v_upd_col, v_upd_col), v_ctid)))
        || jsonb_build_object('delete', osp_test.write_verdict(osp_test.try_as(p_class, 'count',
             format('DELETE FROM public.%I WHERE ctid = $1', r.relname), v_ctid)));

    -- Обновляемое представление (PostgreSQL сам переводит запись в базовую таблицу — с правами
    -- владельца представления, мимо RLS базовой таблицы). Строка — первая видимая классу, по первому
    -- столбцу. Нет видимых строк — n/a.
    ELSIF r.relkind = 'v' AND (pg_relation_is_updatable(r.oid, true) & 4) = 4 THEN
      SELECT a.attname, a.atttypid = 'uuid'::regtype INTO v_key_col, v_key_uuid
      FROM pg_attribute a WHERE a.attrelid = r.oid AND a.attnum = 1;
      v_key := osp_test.try_as(p_class, 'value',
        format('SELECT %I::text FROM public.%I ORDER BY 1 LIMIT 1', v_key_col, r.relname));
      IF v_key LIKE 'ok:_%' THEN
        v_key := substr(v_key, 4);
        v_row_text := osp_test.try_as(p_class, 'value',
          format('SELECT to_jsonb(t)::text FROM public.%I t WHERE %I::text = %L LIMIT 1', r.relname, v_key_col, v_key));
        SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position),
               string_agg(CASE WHEN column_name = v_key_col AND v_key_uuid THEN 'gen_random_uuid()'
                               ELSE 'x.' || quote_ident(column_name) END, ', ' ORDER BY ordinal_position)
          INTO v_cols, v_vals
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = r.relname AND is_updatable = 'YES';
        item := item
          || jsonb_build_object('insert', CASE
               WHEN NOT v_key_uuid OR v_row_text NOT LIKE 'ok:_%' OR (pg_relation_is_updatable(r.oid, true) & 8) <> 8 THEN 'n/a'
               ELSE osp_test.write_verdict(osp_test.try_as(p_class, 'count',
                 format('INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $2) x',
                        r.relname, v_cols, v_vals, r.relname), NULL, substr(v_row_text, 4)::jsonb)) END)
          || jsonb_build_object('update', osp_test.write_verdict(osp_test.try_as(p_class, 'count',
               format('UPDATE public.%I SET %I = %I WHERE %I::text = %L', r.relname, v_key_col, v_key_col, v_key_col, v_key))))
          || jsonb_build_object('delete', CASE WHEN (pg_relation_is_updatable(r.oid, true) & 16) <> 16 THEN 'n/a'
               ELSE osp_test.write_verdict(osp_test.try_as(p_class, 'count',
                 format('DELETE FROM public.%I WHERE %I::text = %L', r.relname, v_key_col, v_key))) END);
      ELSE
        item := item || jsonb_build_object('insert', 'n/a', 'update', 'n/a', 'delete', 'n/a');
      END IF;
    END IF;
    res := res || jsonb_build_object(r.relname, item);
  END LOOP;
  RETURN res;
END $$;

-- SECURITY DEFINER-функции, которые может вызвать аноним (q2): вызов с NULL-аргументами
-- под anon в откатываемой транзакции. ok — функция отработала, err:<код> — отказала.
CREATE OR REPLACE FUNCTION osp_test.anon_functions() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  f record;
  res jsonb := '{}'::jsonb;
  v_args text;
  v_res text;
BEGIN
  FOR f IN
    SELECT p.oid, p.proname, p.pronargs, p.proargtypes
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.prosecdef AND p.prokind = 'f'
      AND p.prorettype <> 'trigger'::regtype
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
    ORDER BY p.proname, p.oid
  LOOP
    SELECT coalesce(string_agg('NULL::' || format_type(t, NULL), ', ' ORDER BY ord), '')
      INTO v_args
    FROM unnest(f.proargtypes::oid[]) WITH ORDINALITY AS a(t, ord);
    v_res := osp_test.try_as('anon', 'value', format('SELECT public.%I(%s)::text', f.proname, v_args));
    res := res || jsonb_build_object(f.proname, CASE WHEN v_res LIKE 'ok:%' THEN 'ok' ELSE v_res END);
  END LOOP;
  RETURN res;
END $$;

-- Самоповышение до администратора через employee_directory: класс меняет себе role на 'admin' и
-- спрашивает is_admin(). Всё в откатываемой транзакции. 'admin' — дыра, 'not_admin' — закрыта,
-- err:<код> — отказ на запись.
CREATE OR REPLACE FUNCTION osp_test.self_promote(p_class text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  u osp_test.users%ROWTYPE;
  v_admin boolean;
  v_state text;
  v_detail text;
BEGIN
  SELECT * INTO u FROM osp_test.users WHERE class = p_class;
  IF u.id IS NULL OR u.class = 'admin' THEN RETURN 'n/a'; END IF;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u.id, 'role', u.db_role)::text, true);
    PERFORM set_config('request.jwt.claim.sub', u.id::text, true);
    PERFORM set_config('statement_timeout', '30s', true);
    EXECUTE format('SET LOCAL ROLE %I', u.db_role);
    EXECUTE 'UPDATE public.employee_directory SET role = ''admin'' WHERE user_id = auth.uid()';
    EXECUTE 'SELECT public.is_admin()' INTO v_admin;
    RAISE EXCEPTION 'osp_test rollback' USING ERRCODE = 'OSP01',
      DETAIL = CASE WHEN v_admin THEN 'admin' ELSE 'not_admin' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
    IF v_state = 'OSP01' THEN RETURN v_detail; END IF;
    RETURN 'err:' || v_state;
  END;
END $$;
