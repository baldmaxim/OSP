-- Права под одну учётку (load.sh --single-owner). Та же транзакция, что и загрузка; выполняется после
-- политик из копии (они уже «для всех», роли записаны в osp_meta.policy_roles — lib/rewrite.mjs).
--
-- В базе одна учётка — владелец; ролей Supabase (anon, authenticated, service_role) нет. PostgreSQL не
-- применяет правила по строкам к владельцу таблицы, поэтому:
--   1. FORCE ROW LEVEL SECURITY на каждой таблице: правила действуют и на владельца.
--   2. Каждая политика получает проверку роли из токена запроса (auth.role()): раньше её делало само
--      PostgreSQL по роли подключения (TO authenticated / TO anon).
--   3. Пропуск. Служебные функции (SECURITY DEFINER) в Supabase выполнялись под владельцем с правом
--      обходить правила. Здесь то же даёт отметка application_name = 'osp:internal', которая стоит
--      ТОЛЬКО на время работы такой функции (ALTER FUNCTION … SET) и сама снимается при выходе из неё,
--      в том числе по ошибке. Своя настройка (osp.*) для этого не годится: задать её функции может лишь
--      суперпользователь, а application_name — любой владелец функции, и на результаты запросов она не
--      влияет. Запрос клиента её выставить не может: PostgREST и шлюз настроек от клиента не принимают;
--      в начале каждой транзакции оба ставят своё имя, так что отметка не «достаётся» от прежнего сеанса.
--      Именем подключения её тоже не задать: пулер Яндекса дописывает к имени адрес клиента. Служебные
--      инструменты ставят отметку командой внутри транзакции (SET LOCAL / set_config).
--      Тот же пропуск — у служебного ключа (роль service_role в токене), как в Supabase.
--   4. Условие политики обёрнуто в CASE: при пропуске исходное условие не вычисляется вовсе. Без этого
--      функция-проверка, читающая таблицу со своей же политикой, вызывала бы себя бесконечно.
--   5. Материализованные представления правил по строкам не имеют: они уходят в закрытую схему
--      osp_private, которую PostgREST наружу не отдаёт. Читают их только представления реестра.
--   6. Копия auth.users (вход остаётся в Supabase Auth) закрыта так же: только служебным функциям.
--   7. Представления, через которые PostgreSQL сам пишет в таблицу, закрыты на запись: на проде запись
--      через них снята выдачей прав, а чтение идёт с правами владельца.
--   8. Каждый запрос PostgREST начинается с osp_private.pre_request(): часовой пояс UTC, своё имя
--      подключения (снимает отметку пропуска, если она осталась от прежнего сеанса пулера), таймаут по
--      виду пользователя и отказ, если запрос пришёл не от шлюза (в токене нет роли пользователя).
-- Кому какие таблицы, действия и функции доступны вообще (то, что в Supabase решала выдача прав),
-- решает шлюз osp-api по своему списку.

CREATE SCHEMA osp_private;

-- Обе функции — без собственных настроек и только из встроенных вызовов: так планировщик подставляет
-- их тело в запрос. В политиках они стоят в подзапросе ( SELECT … ) и вычисляются один раз на запрос,
-- а не на каждую строку.
CREATE FUNCTION osp_private.bypass() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT coalesce(pg_catalog.current_setting('application_name', true), '') = 'osp:internal' OR coalesce(auth.role(), '') = 'service_role' $$;

-- Роль из токена запроса; без токена — аноним.
CREATE FUNCTION osp_private.role_in(VARIADIC p_roles text[]) RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT coalesce(nullif(auth.role(), ''), 'anon') = ANY (p_roles) $$;

-- Начало каждого запроса PostgREST (db-pre-request). Таймауты: аноним — 3 с, как у роли anon в Supabase;
-- вошедший — 30 с. У роли authenticated в Supabase по умолчанию 8 с; здесь запас: правила с проверкой на
-- каждую строку под одной учёткой в 2,5–3 раза медленнее (migration/CUTOVER.md, «Известные отличия по
-- скорости»), и действие, укладывавшееся в 8 с, не должно начать обрываться. Служебные — 120 с.
CREATE FUNCTION osp_private.pre_request() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_role text := coalesce(auth.role(), '');
BEGIN
  PERFORM set_config('TimeZone', 'UTC', true), set_config('application_name', 'osp-postgrest', true);
  IF v_role NOT IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'запрос не от шлюза: в токене нет роли пользователя' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'authenticated' AND auth.uid() IS NULL THEN
    RAISE EXCEPTION 'запрос не от шлюза: у вошедшего нет идентификатора' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('statement_timeout', CASE v_role WHEN 'anon' THEN '3s' WHEN 'authenticated' THEN '30s' ELSE '120s' END, true);
END $$;

-- Копия учёток Supabase Auth: только то, что читают и меняют служебные функции портала
-- (get_auth_users, admin_confirm_user_email, admin_delete_user). Паролей здесь нет и не будет.
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  aud text,
  role text,
  email text,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  raw_user_meta_data jsonb
);

DO $single_owner$
DECLARE
  t record;
  p record;
  f record;
  m record;
  v_guard text;
  v_sql text;
  v_missing int;
  v_stable text[];
  v_fn text;
BEGIN
  -- Каждой политике из копии известны её роли; лишних записей о ролях тоже нет.
  SELECT count(*) INTO v_missing
  FROM pg_policies pp
  LEFT JOIN osp_meta.policy_roles r ON r.schema_name = pp.schemaname AND r.table_name = pp.tablename AND r.policy_name = pp.policyname
  WHERE pp.schemaname = 'public' AND r.policy_name IS NULL;
  IF v_missing > 0 THEN RAISE EXCEPTION 'политик без записи о ролях: %', v_missing; END IF;
  SELECT count(*) INTO v_missing
  FROM osp_meta.policy_roles r
  LEFT JOIN pg_policies pp ON r.schema_name = pp.schemaname AND r.table_name = pp.tablename AND r.policy_name = pp.policyname
  WHERE pp.policyname IS NULL;
  IF v_missing > 0 THEN RAISE EXCEPTION 'записей о ролях без политики: %', v_missing; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND permissive <> 'PERMISSIVE') THEN
    RAISE EXCEPTION 'ограничивающие (RESTRICTIVE) политики в режиме одной учётки не поддерживаются';
  END IF;

  -- Функции-проверки без аргументов, не меняющие ответ в пределах запроса (STABLE): is_admin(),
  -- is_portal_employee() и подобные. В условии политики такой вызов берётся в подзапрос — тогда он
  -- вычисляется один раз на запрос, а не на каждую строку. Ответ тот же: функция STABLE; на таблицах
  -- в десятки тысяч строк это секунды. Вызовы, уже стоящие в подзапросе, не трогаются.
  SELECT coalesce(array_agg(p3.proname ORDER BY length(p3.proname) DESC, p3.proname), '{}') INTO v_stable
  FROM pg_proc p3 JOIN pg_namespace n ON n.oid = p3.pronamespace
  WHERE n.nspname = 'public' AND p3.prokind = 'f' AND p3.pronargs = 0 AND p3.provolatile IN ('s', 'i')
    AND NOT p3.proretset AND p3.prorettype <> 'trigger'::regtype;

  -- 2 и 4. Условие каждой политики: пропуск → да; иначе роль из токена И исходное условие.
  FOR p IN
    SELECT pol.polname, c.relname, pg_get_expr(pol.polqual, pol.polrelid) AS qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) AS chk, r.roles
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN osp_meta.policy_roles r ON r.schema_name = 'public' AND r.table_name = c.relname AND r.policy_name = pol.polname
    ORDER BY c.relname, pol.polname
  LOOP
    v_guard := format('osp_private.role_in(%s)', (SELECT string_agg(quote_literal(x), ', ' ORDER BY x) FROM unnest(p.roles) x));
    FOREACH v_fn IN ARRAY v_stable LOOP
      p.qual := regexp_replace(p.qual, '(?<![\w.])(?<!SELECT )(?:public\.)?' || v_fn || '\(\)', '( SELECT public.' || v_fn || '())', 'g');
      p.chk := regexp_replace(p.chk, '(?<![\w.])(?<!SELECT )(?:public\.)?' || v_fn || '\(\)', '( SELECT public.' || v_fn || '())', 'g');
    END LOOP;
    v_sql := format('ALTER POLICY %I ON public.%I', p.polname, p.relname);
    IF p.qual IS NOT NULL THEN
      v_sql := v_sql || format(' USING (CASE WHEN (SELECT osp_private.bypass()) THEN true ELSE ((SELECT %s) AND (%s)) END)', v_guard, p.qual);
    END IF;
    IF p.chk IS NOT NULL THEN
      v_sql := v_sql || format(' WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true ELSE ((SELECT %s) AND (%s)) END)', v_guard, p.chk);
    END IF;
    EXECUTE v_sql;
  END LOOP;

  -- 1 и 3. Все таблицы: правила включены, действуют на владельца; пропуск для служебных функций.
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('CREATE POLICY osp_internal ON public.%I FOR ALL TO PUBLIC USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()))', t.relname);
  END LOOP;

  -- 7. Представления, обновляемые самим PostgreSQL, — только на чтение. Если какая-то функция портала
  -- пишет через представление, правило сломало бы её молча — тогда отказ, разбираться вручную.
  FOR t IN
    SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'v' AND (pg_relation_is_updatable(c.oid, false) & 28) <> 0
    ORDER BY c.relname
  LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p2 JOIN pg_namespace n ON n.oid = p2.pronamespace
               WHERE n.nspname = 'public'
                 AND p2.prosrc ~* ('(insert\s+into|update|delete\s+from)\s+(public\.)?' || t.relname || '\M')) THEN
      RAISE EXCEPTION 'функция пишет через представление %: закрыть его на запись нельзя', t.relname;
    END IF;
    EXECUTE format('CREATE RULE osp_readonly_insert AS ON INSERT TO public.%I DO INSTEAD NOTHING', t.relname);
    EXECUTE format('CREATE RULE osp_readonly_update AS ON UPDATE TO public.%I DO INSTEAD NOTHING', t.relname);
    EXECUTE format('CREATE RULE osp_readonly_delete AS ON DELETE TO public.%I DO INSTEAD NOTHING', t.relname);
  END LOOP;

  -- 6. Копия учёток — только служебным функциям.
  ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE auth.users FORCE ROW LEVEL SECURITY;
  CREATE POLICY osp_internal ON auth.users FOR ALL TO PUBLIC USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

  -- 3. Служебные функции: пропуск на время работы.
  FOR f IN
    SELECT p2.oid::regprocedure AS sig
    FROM pg_proc p2 JOIN pg_namespace n ON n.oid = p2.pronamespace
    WHERE n.nspname = 'public' AND p2.prosecdef
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p2.oid AND d.deptype = 'e')
    ORDER BY 1
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET application_name = %L', f.sig, 'osp:internal');
  END LOOP;

  -- 5. Материализованные представления — в закрытую схему. Представления над ними ссылаются на них
  -- по внутреннему номеру и продолжают работать; функции, называющие их по имени, получают новое имя.
  FOR m IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'm' ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER MATERIALIZED VIEW public.%I SET SCHEMA osp_private', m.relname);
    -- Имя встречается и со схемой (public.имя), и без неё (функция с search_path = public).
    FOR f IN
      SELECT p2.oid, pg_get_functiondef(p2.oid) AS def
      FROM pg_proc p2 JOIN pg_namespace n ON n.oid = p2.pronamespace
      WHERE n.nspname = 'public' AND p2.prokind = 'f' AND p2.prosrc ~ ('\m' || m.relname || '\M')
    LOOP
      EXECUTE regexp_replace(
        regexp_replace(f.def, '\mpublic\.' || m.relname || '\M', 'osp_private.' || m.relname, 'g'),
        '(?<![\w.])' || m.relname || '\M', 'osp_private.' || m.relname, 'g');
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc p2 JOIN pg_namespace n ON n.oid = p2.pronamespace
               WHERE n.nspname = 'public' AND p2.prosrc ~ ('(?<!osp_private\.)\m' || m.relname || '\M')) THEN
      RAISE EXCEPTION 'функция обращается к % мимо закрытой схемы: после переноса она его не найдёт', m.relname;
    END IF;
  END LOOP;
END
$single_owner$;
