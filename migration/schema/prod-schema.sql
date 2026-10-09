--
-- PostgreSQL database dump
--

\restrict EMAUI6767DCT6AtdVJNjnJWdHCdfQtCdQwcz0pJbvprL2pnXJpGueNJk5F4L9Vb

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: supabase_admin
--

CREATE SCHEMA auth;


ALTER SCHEMA auth OWNER TO supabase_admin;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: aal_level; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.aal_level AS ENUM (
    'aal1',
    'aal2',
    'aal3'
);


ALTER TYPE auth.aal_level OWNER TO supabase_auth_admin;

--
-- Name: code_challenge_method; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.code_challenge_method AS ENUM (
    's256',
    'plain'
);


ALTER TYPE auth.code_challenge_method OWNER TO supabase_auth_admin;

--
-- Name: factor_status; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.factor_status AS ENUM (
    'unverified',
    'verified'
);


ALTER TYPE auth.factor_status OWNER TO supabase_auth_admin;

--
-- Name: factor_type; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.factor_type AS ENUM (
    'totp',
    'webauthn',
    'phone',
    'recovery_code'
);


ALTER TYPE auth.factor_type OWNER TO supabase_auth_admin;

--
-- Name: oauth_authorization_status; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.oauth_authorization_status AS ENUM (
    'pending',
    'approved',
    'denied',
    'expired'
);


ALTER TYPE auth.oauth_authorization_status OWNER TO supabase_auth_admin;

--
-- Name: oauth_client_type; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.oauth_client_type AS ENUM (
    'public',
    'confidential'
);


ALTER TYPE auth.oauth_client_type OWNER TO supabase_auth_admin;

--
-- Name: oauth_registration_type; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.oauth_registration_type AS ENUM (
    'dynamic',
    'manual'
);


ALTER TYPE auth.oauth_registration_type OWNER TO supabase_auth_admin;

--
-- Name: oauth_response_type; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.oauth_response_type AS ENUM (
    'code'
);


ALTER TYPE auth.oauth_response_type OWNER TO supabase_auth_admin;

--
-- Name: one_time_token_type; Type: TYPE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TYPE auth.one_time_token_type AS ENUM (
    'confirmation_token',
    'reauthentication_token',
    'recovery_token',
    'email_change_token_new',
    'email_change_token_current',
    'phone_change_token'
);


ALTER TYPE auth.one_time_token_type OWNER TO supabase_auth_admin;

--
-- Name: counterparty_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.counterparty_status AS ENUM (
    'active',
    'blacklist'
);


ALTER TYPE public.counterparty_status OWNER TO postgres;

--
-- Name: object_document_type; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.object_document_type AS ENUM (
    'general_contract',
    'general_contract_attachment',
    'additional_agreement',
    'attachment'
);


ALTER TYPE public.object_document_type OWNER TO postgres;

--
-- Name: object_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.object_status AS ENUM (
    'main_construction',
    'warranty_service'
);


ALTER TYPE public.object_status OWNER TO postgres;

--
-- Name: tender_counterparty_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.tender_counterparty_status AS ENUM (
    'request_sent',
    'declined',
    'proposal_provided',
    'accepted_for_work'
);


ALTER TYPE public.tender_counterparty_status OWNER TO postgres;

--
-- Name: email(); Type: FUNCTION; Schema: auth; Owner: supabase_auth_admin
--

CREATE FUNCTION auth.email() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;


ALTER FUNCTION auth.email() OWNER TO supabase_auth_admin;

--
-- Name: FUNCTION email(); Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON FUNCTION auth.email() IS 'Deprecated. Use auth.jwt() -> ''email'' instead.';


--
-- Name: jwt(); Type: FUNCTION; Schema: auth; Owner: supabase_auth_admin
--

CREATE FUNCTION auth.jwt() RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  select 
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$$;


ALTER FUNCTION auth.jwt() OWNER TO supabase_auth_admin;

--
-- Name: role(); Type: FUNCTION; Schema: auth; Owner: supabase_auth_admin
--

CREATE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;


ALTER FUNCTION auth.role() OWNER TO supabase_auth_admin;

--
-- Name: FUNCTION role(); Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON FUNCTION auth.role() IS 'Deprecated. Use auth.jwt() -> ''role'' instead.';


--
-- Name: uid(); Type: FUNCTION; Schema: auth; Owner: supabase_auth_admin
--

CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;


ALTER FUNCTION auth.uid() OWNER TO supabase_auth_admin;

--
-- Name: FUNCTION uid(); Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON FUNCTION auth.uid() IS 'Deprecated. Use auth.jwt() -> ''sub'' instead.';


--
-- Name: admin_confirm_user_email(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.admin_confirm_user_email(target_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth', 'pg_temp'
    AS $$
BEGIN
  IF NOT (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.is_approved = true
    )
    OR EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = auth.uid() AND lower(u.email) = 'sadovnikov.d.y@su10.ru'
    )
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав: подтверждать почту может только администратор'
      USING ERRCODE = '42501';
  END IF;

  UPDATE auth.users
  SET email_confirmed_at = now()
  WHERE id = target_user_id AND email_confirmed_at IS NULL;
END;
$$;


ALTER FUNCTION public.admin_confirm_user_email(target_user_id uuid) OWNER TO postgres;

--
-- Name: FUNCTION admin_confirm_user_email(target_user_id uuid); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.admin_confirm_user_email(target_user_id uuid) IS 'Подтвердить почту пользователя вручную (ссылка из письма не сработала). Только администратор.';


--
-- Name: admin_delete_user(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.admin_delete_user(target_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
DECLARE
    v_caller_role TEXT;
BEGIN
    SELECT role INTO v_caller_role
    FROM public.user_roles
    WHERE user_id = auth.uid() AND is_approved = true
    LIMIT 1;

    IF v_caller_role IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'Insufficient privileges: only admin can delete users';
    END IF;

    -- Не даём админу удалить самого себя
    IF target_user_id = auth.uid() THEN
        RAISE EXCEPTION 'Cannot delete yourself';
    END IF;

    DELETE FROM public.user_roles WHERE user_id = target_user_id;
    DELETE FROM auth.users WHERE id = target_user_id;
END;
$$;


ALTER FUNCTION public.admin_delete_user(target_user_id uuid) OWNER TO postgres;

--
-- Name: FUNCTION admin_delete_user(target_user_id uuid); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.admin_delete_user(target_user_id uuid) IS 'Полное удаление пользователя (auth.users + user_roles). Доступно только администраторам.';


--
-- Name: can_see_task(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.can_see_task(task_uuid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT public.is_admin()
      OR EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.id = task_uuid
          AND (t.assignee_user_id = auth.uid() OR t.created_by_user_id = auth.uid())
      )
      OR public.is_task_participant(task_uuid);
$$;


ALTER FUNCTION public.can_see_task(task_uuid uuid) OWNER TO postgres;

--
-- Name: contracts_delete_guard(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.contracts_delete_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  children TEXT;
BEGIN
  -- Реагируем и на soft delete (проставление deleted_at), и на физический DELETE.
  IF TG_OP = 'UPDATE' AND (OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL) THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(display_id::text, ', ' ORDER BY display_id) INTO children
  FROM contracts
  WHERE parent_contract_id = COALESCE(NEW.id, OLD.id) AND deleted_at IS NULL;

  IF children IS NOT NULL THEN
    RAISE EXCEPTION 'Сначала удалите зависимые документы: ID %', children;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.contracts_delete_guard() OWNER TO postgres;

--
-- Name: contracts_hierarchy_guard(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.contracts_hierarchy_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  parent_row contracts%ROWTYPE;
  blocking_id BIGINT;
  blocking_list TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.record_type IS DISTINCT FROM OLD.record_type THEN
    RAISE EXCEPTION 'Тип документа изменить нельзя. Создайте новый документ нужного типа';
  END IF;

  IF NEW.record_type = 'dp' THEN
    IF NEW.parent_contract_id IS NOT NULL THEN
      RAISE EXCEPTION 'У основного договора не может быть изменяемого документа';
    END IF;
    NEW.root_contract_id := NEW.id;
  ELSE
    IF NEW.parent_contract_id IS NULL THEN
      RAISE EXCEPTION 'Для ДС нужно указать изменяемый документ';
    END IF;

    SELECT * INTO parent_row FROM contracts WHERE id = NEW.parent_contract_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Изменяемый документ не найден';
    END IF;
    IF parent_row.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Изменяемый документ ID % удалён', parent_row.display_id;
    END IF;

    IF NEW.record_type = 'ds_extra' AND parent_row.record_type <> 'dp' THEN
      RAISE EXCEPTION 'ДС на дополнительные работы создаётся только к основному договору (ID % — не договор)', parent_row.display_id;
    END IF;

    IF NEW.record_type = 'ds_vor' THEN
      SELECT display_id INTO blocking_id
      FROM contracts
      WHERE parent_contract_id = NEW.parent_contract_id
        AND record_type = 'ds_vor'
        AND deleted_at IS NULL
        AND id <> NEW.id
      LIMIT 1;
      IF blocking_id IS NOT NULL THEN
        RAISE EXCEPTION 'Документ ID % уже изменён соглашением ID %. Новое изменение создавайте к нему',
          parent_row.display_id, blocking_id;
      END IF;

      IF parent_row.record_type = 'ds_vor' AND parent_row.status <> 'completed' THEN
        RAISE EXCEPTION 'ДС ID % ещё не завершено. В одной ветке допускается только одно незавершённое изменение',
          parent_row.display_id;
      END IF;
    END IF;

    NEW.root_contract_id := COALESCE(parent_row.root_contract_id, parent_row.id);
  END IF;

  -- Завершённый документ не правим задним числом: иначе актуальные условия и
  -- суммы поменялись бы молча, без следа в истории.
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' AND NEW.status = 'completed'
     AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN
    IF (NEW.contract_amount, NEW.gp_amount, NEW.currency, NEW.vat_rate, NEW.amount_includes_vat,
        NEW.bsm, NEW.work_start_date, NEW.work_end_date, NEW.warranty_retention_percent,
        NEW.warranty_retention_period, NEW.warranty_period, NEW.work_name,
        NEW.contract_number, NEW.contract_date, NEW.parent_contract_id, NEW.changed_fields)
       IS DISTINCT FROM
       (OLD.contract_amount, OLD.gp_amount, OLD.currency, OLD.vat_rate, OLD.amount_includes_vat,
        OLD.bsm, OLD.work_start_date, OLD.work_end_date, OLD.warranty_retention_percent,
        OLD.warranty_retention_period, OLD.warranty_period, OLD.work_name,
        OLD.contract_number, OLD.contract_date, OLD.parent_contract_id, OLD.changed_fields)
    THEN
      RAISE EXCEPTION 'Документ ID % завершён. Чтобы изменить условия, сначала верните его из статуса «Завершено»', OLD.display_id;
    END IF;
  END IF;

  -- Выход из «Завершено» — только снизу вверх: пока у документа есть живые
  -- потомки, их условия опираются на его актуальное состояние.
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' AND NEW.status <> 'completed' THEN
    SELECT string_agg(display_id::text, ', ' ORDER BY display_id) INTO blocking_list
    FROM contracts WHERE parent_contract_id = NEW.id AND deleted_at IS NULL;
    IF blocking_list IS NOT NULL THEN
      RAISE EXCEPTION 'Сначала верните на доработку зависимые документы: ID %', blocking_list;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION public.contracts_hierarchy_guard() OWNER TO postgres;

--
-- Name: contracts_psdc_total_guard(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.contracts_psdc_total_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF COALESCE(current_setting('osp.psdc_write', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.psdc_total := NULL;
    NEW.psdc_applied_id := NULL;
  ELSIF NEW.psdc_total IS DISTINCT FROM OLD.psdc_total
     OR NEW.psdc_applied_id IS DISTINCT FROM OLD.psdc_applied_id THEN
    RAISE EXCEPTION 'Сумма по ПСДЦ меняется только действиями «Применить ВОР» и «Удалить ВОР»';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.contracts_psdc_total_guard() OWNER TO postgres;

--
-- Name: current_counterparty_id(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.current_counterparty_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT ur.counterparty_id
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid() AND ur.is_approved = true
  LIMIT 1;
$$;


ALTER FUNCTION public.current_counterparty_id() OWNER TO postgres;

--
-- Name: general_document_folders_validate(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.general_document_folders_validate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  ancestor UUID;
  parent_cat TEXT;
  depth INT := 0;
BEGIN
  NEW.updated_at := NOW();
  NEW.name := btrim(NEW.name);

  IF NEW.parent_id IS NOT NULL THEN
    SELECT category INTO parent_cat
      FROM general_document_folders WHERE id = NEW.parent_id;
    IF parent_cat IS NULL THEN
      RAISE EXCEPTION 'Родительская папка % не найдена', NEW.parent_id;
    END IF;
    -- Вложенная папка всегда в той же подгруппе, что и родитель.
    NEW.category := parent_cat;

    ancestor := NEW.parent_id;
    WHILE ancestor IS NOT NULL LOOP
      IF ancestor = NEW.id THEN
        RAISE EXCEPTION 'Нельзя переместить папку внутрь самой себя';
      END IF;
      depth := depth + 1;
      IF depth > 20 THEN
        RAISE EXCEPTION 'Слишком глубокая вложенность папок (максимум 20 уровней)';
      END IF;
      SELECT parent_id INTO ancestor
        FROM general_document_folders WHERE id = ancestor;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION public.general_document_folders_validate() OWNER TO postgres;

--
-- Name: general_documents_sync_folder_category(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.general_documents_sync_folder_category() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  folder_cat TEXT;
BEGIN
  IF NEW.folder_id IS NOT NULL THEN
    SELECT category INTO folder_cat
      FROM general_document_folders WHERE id = NEW.folder_id;
    IF folder_cat IS NULL THEN
      RAISE EXCEPTION 'Папка % не найдена', NEW.folder_id;
    END IF;
    NEW.category := folder_cat;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.general_documents_sync_folder_category() OWNER TO postgres;

--
-- Name: get_auth_users(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.get_auth_users() RETURNS TABLE(id uuid, email text, created_at timestamp with time zone, last_sign_in_at timestamp with time zone, email_confirmed_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'auth', 'pg_temp'
    AS $$
BEGIN
  IF NOT (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.is_approved = true
    )
    OR EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = auth.uid() AND lower(u.email) = 'sadovnikov.d.y@su10.ru'
    )
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав: список пользователей доступен только администратору'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT au.id, au.email::TEXT, au.created_at, au.last_sign_in_at, au.email_confirmed_at
  FROM auth.users au
  ORDER BY au.created_at ASC;
END;
$$;


ALTER FUNCTION public.get_auth_users() OWNER TO postgres;

--
-- Name: FUNCTION get_auth_users(); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.get_auth_users() IS 'Пользователи auth.users (с датой подтверждения почты) для «Администрирования». Только администратор.';


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.is_approved = true
  )
  OR EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = auth.uid() AND lower(u.email) = 'sadovnikov.d.y@su10.ru'
  );
$$;


ALTER FUNCTION public.is_admin() OWNER TO postgres;

--
-- Name: is_my_contract(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_my_contract(contract_uuid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT public.current_counterparty_id() IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE c.id = contract_uuid AND c.counterparty_id = public.current_counterparty_id()
    )
    OR EXISTS (
      SELECT 1 FROM public.contract_counterparties cc
      WHERE cc.contract_id = contract_uuid AND cc.counterparty_id = public.current_counterparty_id()
    )
  );
$$;


ALTER FUNCTION public.is_my_contract(contract_uuid uuid) OWNER TO postgres;

--
-- Name: is_my_tender(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_my_tender(tender_uuid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT public.current_counterparty_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tender_counterparties tc
    WHERE tc.tender_id = tender_uuid
      AND tc.counterparty_id = public.current_counterparty_id()
  );
$$;


ALTER FUNCTION public.is_my_tender(tender_uuid uuid) OWNER TO postgres;

--
-- Name: FUNCTION is_my_tender(tender_uuid uuid); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.is_my_tender(tender_uuid uuid) IS 'Текущий пользователь — подрядчик, приглашённый в этот тендер';


--
-- Name: is_negotiation_employee(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_negotiation_employee() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.is_approved = true
      AND ur.counterparty_id IS NULL
  );
$$;


ALTER FUNCTION public.is_negotiation_employee() OWNER TO postgres;

--
-- Name: is_portal_employee(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_portal_employee() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.is_approved = true
      AND ur.counterparty_id IS NULL
  );
$$;


ALTER FUNCTION public.is_portal_employee() OWNER TO postgres;

--
-- Name: FUNCTION is_portal_employee(); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.is_portal_employee() IS 'Подтверждённый пользователь без привязки к контрагенту = сотрудник СУ-10 (полный доступ)';


--
-- Name: is_task_participant(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_task_participant(task_uuid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM task_participants tp
    WHERE tp.task_id = task_uuid AND tp.user_id = auth.uid()
  );
$$;


ALTER FUNCTION public.is_task_participant(task_uuid uuid) OWNER TO postgres;

--
-- Name: kp_norm_name(text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.kp_norm_name(s text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select trim(regexp_replace(
    regexp_replace(
      translate(
        replace(replace(replace(lower(coalesce(s, '')), 'ё', 'е'), '²', '2'), '³', '3'),
        'acepxyo', 'асерхуо'
      ),
      '[«»"''`()]', '', 'g'),
    '[\s.]+', ' ', 'g'))
$$;


ALTER FUNCTION public.kp_norm_name(s text) OWNER TO postgres;

--
-- Name: kp_norm_unit(text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.kp_norm_unit(u text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select case public.kp_norm_name(u)
    when 'штук' then 'шт' when 'штука' then 'шт' when 'штуки' then 'шт'
    when 'комплект' then 'компл' when 'комплекта' then 'компл' when 'комплектов' then 'компл'
    when 'к-т' then 'компл' when 'к т' then 'компл'
    when 'кв м' then 'м2' when 'квм' then 'м2' when 'м кв' then 'м2'
    when 'куб м' then 'м3' when 'кубм' then 'м3' when 'м куб' then 'м3'
    when 'м п' then 'мп' when 'пог м' then 'мп' when 'погм' then 'мп'
    when 'п м' then 'мп' when 'пм' then 'мп' when 'м пог' then 'мп'
    else public.kp_norm_name(u)
  end
$$;


ALTER FUNCTION public.kp_norm_unit(u text) OWNER TO postgres;

--
-- Name: list_sto_employees(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.list_sto_employees() RETURNS TABLE(user_id uuid, display_name text, role text, role_label text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT ur.user_id,
         COALESCE(NULLIF(btrim(ur.full_name), ''), ur.email) AS display_name,
         ur.role,
         r.label AS role_label
  FROM public.user_roles ur
  JOIN public.roles r ON r.key = ur.role
  WHERE ur.is_approved = true
    AND ur.role <> 'contractor'
    AND ur.counterparty_id IS NULL
    AND (r.label ILIKE '%сметн%' OR r.key ILIKE 'sto%')
    AND EXISTS (
      SELECT 1 FROM public.user_roles me
      WHERE me.user_id = auth.uid()
        AND me.is_approved = true
        AND me.role <> 'contractor'
    )
  ORDER BY 2;
$$;


ALTER FUNCTION public.list_sto_employees() OWNER TO postgres;

--
-- Name: FUNCTION list_sto_employees(); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.list_sto_employees() IS 'Сотрудники сметно-технического отдела (роль с «сметн» в названии или ключом sto*) для выбора ответственного СТО';


--
-- Name: list_supply_employees(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.list_supply_employees() RETURNS TABLE(user_id uuid, display_name text, role text, role_label text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT ur.user_id,
         COALESCE(NULLIF(btrim(ur.full_name), ''), ur.email) AS display_name,
         ur.role,
         r.label AS role_label
  FROM public.user_roles ur
  JOIN public.roles r ON r.key = ur.role
  WHERE ur.is_approved = true
    AND ur.role <> 'contractor'
    AND ur.counterparty_id IS NULL
    AND (r.label ILIKE '%снабж%' OR r.key ILIKE 'supply%')
    AND EXISTS (
      SELECT 1 FROM public.user_roles me
      WHERE me.user_id = auth.uid()
        AND me.is_approved = true
        AND me.role <> 'contractor'
    )
  ORDER BY 2;
$$;


ALTER FUNCTION public.list_supply_employees() OWNER TO postgres;

--
-- Name: FUNCTION list_supply_employees(); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.list_supply_employees() IS 'Сотрудники отдела снабжения (роль с «снабж» в названии или ключом supply*) для выбора ответственного за тендер на материалы';


--
-- Name: protect_dispute_columns(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.protect_dispute_columns() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF public.current_counterparty_id() IS NOT NULL THEN
    NEW.our_text := OLD.our_text;
    NEW.final_text := OLD.final_text;
    NEW.status := OLD.status;
    NEW.contract_id := OLD.contract_id;
    NEW.counterparty_id := OLD.counterparty_id;
    NEW.created_by_side := OLD.created_by_side;
    NEW.label := OLD.label;
  END IF;
  RETURN NEW;
END; $$;


ALTER FUNCTION public.protect_dispute_columns() OWNER TO postgres;

--
-- Name: psdc_actor(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_actor(OUT user_id uuid, OUT full_name text, OUT role text) RETURNS record
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT auth.uid(),
         (SELECT ur.full_name FROM user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1),
         (SELECT ur.role FROM user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1);
$$;


ALTER FUNCTION public.psdc_actor(OUT user_id uuid, OUT full_name text, OUT role text) OWNER TO postgres;

--
-- Name: psdc_add_rows(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_add_rows(p_psdc_id uuid, p_rows jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
  p psdc%ROWTYPE;
  v_count int;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ПСДЦ не найдена';
  END IF;
  IF p.state <> 'uploaded' OR p.validated_at IS NOT NULL THEN
    RAISE EXCEPTION 'Строки можно добавлять только до проверки файла';
  END IF;
  IF p.uploaded_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Загрузку продолжает только её автор' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 5000 THEN
    RAISE EXCEPTION 'За один запрос передаётся не более 5000 строк';
  END IF;
  -- Предел согласован с браузером (PSDC_LIMITS.rows): проверка такой ведомости
  -- укладывается в лимит времени запроса Supabase.
  IF p.source_row_count + jsonb_array_length(p_rows) > 25000 THEN
    RAISE EXCEPTION 'Слишком много строк в ведомости (более 25 000)';
  END IF;

  INSERT INTO psdc_source_rows (psdc_id, excel_row, cells)
  SELECT p.id, (e ->> 'r')::int,
         COALESCE((
           SELECT jsonb_object_agg(k, v)
           FROM jsonb_each(e -> 'c') AS kv(k, v)
           WHERE k ~ '^[A-U]$' AND jsonb_typeof(v) = 'object' AND length(v::text) <= 40000
         ), '{}'::jsonb)
  FROM jsonb_array_elements(p_rows) e
  WHERE (e ->> 'r') ~ '^[0-9]{1,7}$';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE psdc SET source_row_count = source_row_count + v_count WHERE id = p.id;
  RETURN v_count;
END;
$_$;


ALTER FUNCTION public.psdc_add_rows(p_psdc_id uuid, p_rows jsonb) OWNER TO postgres;

--
-- Name: psdc_apply(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_apply(p_psdc_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  p psdc%ROWTYPE;
  doc contracts%ROWTYPE;
  a record;
  v_reason text;
  v_other bigint;
  v_rate numeric;
  v_incl boolean;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ПСДЦ не найдена';
  END IF;
  IF p.state = 'applied' THEN
    RAISE EXCEPTION 'Эта ПСДЦ уже применена';
  END IF;
  IF p.state NOT IN ('uploaded', 'validated', 'invalid') THEN
    RAISE EXCEPTION 'Загрузка ПСДЦ отменена или удалена';
  END IF;
  IF p.document_id IS NULL THEN
    RAISE EXCEPTION 'Файл не сопоставлен с документом';
  END IF;

  SELECT * INTO doc FROM contracts WHERE id = p.document_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Документ не найден';
  END IF;
  v_reason := psdc_document_lock_reason(doc);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION '%', v_reason USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM psdc WHERE document_id = doc.id AND state = 'applied') THEN
    RAISE EXCEPTION 'У документа ID % уже есть применённая ПСДЦ. Удалите её в карточке документа, затем примените новую', doc.display_id
      USING ERRCODE = '40001', HINT = 'conflict';
  END IF;

  IF p.batch_id IS NOT NULL THEN
    SELECT count(*) INTO v_other FROM psdc
    WHERE batch_id = p.batch_id AND document_id = doc.id AND id <> p.id
      AND state IN ('uploaded', 'validated', 'invalid');
    IF v_other > 0 THEN
      RAISE EXCEPTION 'В пакете документ ID % сопоставлен нескольким файлам — снимите лишнее сопоставление', doc.display_id
        USING ERRCODE = '40001', HINT = 'conflict';
    END IF;
  END IF;

  -- Исходные строки после загрузки неизменяемы, поэтому результат проверки
  -- зависит от документа только через ставку НДС и предыдущую ПСДЦ ветки
  -- (сопоставление ID строк). Если с момента проверки они изменились —
  -- пересчитываем здесь же, в этой транзакции.
  SELECT rate, includes INTO v_rate, v_incl FROM psdc_document_vat(doc.id);
  IF p.state <> 'validated'
     OR p.vat_rate_snapshot IS DISTINCT FROM v_rate
     OR p.vat_included_snapshot IS DISTINCT FROM v_incl
     OR p.previous_psdc_id IS DISTINCT FROM psdc_find_previous(doc.id) THEN
    PERFORM psdc_validate_internal(p.id);
    SELECT * INTO p FROM psdc WHERE id = p_psdc_id;
  END IF;
  IF p.state <> 'validated' THEN
    RAISE EXCEPTION 'ПСДЦ содержит ошибки (%). Исправьте файл и загрузите его заново', p.error_count;
  END IF;

  SELECT * INTO a FROM psdc_actor();
  BEGIN
    UPDATE psdc SET state = 'applied', applied_at = now(), applied_by = a.user_id, applied_by_name = a.full_name
    WHERE id = p.id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'У документа ID % уже есть применённая ПСДЦ', doc.display_id USING ERRCODE = '40001', HINT = 'conflict';
  END;

  PERFORM set_config('osp.psdc_write', 'on', true);
  UPDATE contracts SET psdc_total = p.total, psdc_applied_id = p.id WHERE id = doc.id;
  PERFORM set_config('osp.psdc_write', 'off', true);

  PERFORM psdc_audit(doc.id, 'psdc_applied',
    format('Применена ПСДЦ «%s»: сумма документа %s (ручная сумма %s сохранена)', p.source_filename, p.total::text,
      COALESCE(doc.contract_amount::text, 'не задана')),
    jsonb_build_object('psdc_id', p.id, 'total', p.total::text, 'manual_amount', doc.contract_amount::text,
                       'vat_amount', p.vat_amount::text, 'previous_psdc_id', p.previous_psdc_id));

  RETURN psdc_json(p.id, 0);
END;
$$;


ALTER FUNCTION public.psdc_apply(p_psdc_id uuid) OWNER TO postgres;

--
-- Name: psdc_audit(uuid, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_audit(p_document_id uuid, p_event text, p_description text, p_payload jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  a record;
BEGIN
  IF p_document_id IS NULL THEN RETURN; END IF;
  SELECT * INTO a FROM psdc_actor();
  INSERT INTO contract_audit_log (contract_id, event_type, field_name, new_value, description, changed_by_role, changed_by_name)
  VALUES (p_document_id, p_event, 'psdc', p_payload, p_description, a.role, a.full_name);
END;
$$;


ALTER FUNCTION public.psdc_audit(p_document_id uuid, p_event text, p_description text, p_payload jsonb) OWNER TO postgres;

--
-- Name: psdc_batch_apply(uuid[]); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_batch_apply(p_psdc_ids uuid[]) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_id uuid;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF COALESCE(array_length(p_psdc_ids, 1), 0) > 200 THEN
    RAISE EXCEPTION 'За один запрос применяется не более 200 файлов';
  END IF;
  FOREACH v_id IN ARRAY COALESCE(p_psdc_ids, '{}') LOOP
    BEGIN
      PERFORM psdc_apply(v_id);
      v_results := v_results || jsonb_build_object('psdc_id', v_id, 'ok', true);
    EXCEPTION WHEN others THEN
      v_results := v_results || jsonb_build_object('psdc_id', v_id, 'ok', false, 'error', SQLERRM);
    END;
  END LOOP;
  RETURN v_results;
END;
$$;


ALTER FUNCTION public.psdc_batch_apply(p_psdc_ids uuid[]) OWNER TO postgres;

--
-- Name: psdc_batch_create(text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_batch_create(p_title text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  a record;
  v_id uuid;
BEGIN
  IF NOT psdc_contracts_permission(true) THEN
    RAISE EXCEPTION 'Недостаточно прав для загрузки ПСДЦ' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO a FROM psdc_actor();
  INSERT INTO psdc_batches (title, created_by, created_by_name)
  VALUES (NULLIF(left(btrim(COALESCE(p_title, '')), 200), ''), a.user_id, a.full_name)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


ALTER FUNCTION public.psdc_batch_create(p_title text) OWNER TO postgres;

--
-- Name: psdc_batch_issues(uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_batch_issues(p_batch_id uuid, p_severity text DEFAULT 'error'::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NOT psdc_contracts_permission(true)
     AND NOT EXISTS (SELECT 1 FROM psdc_batches WHERE id = p_batch_id AND created_by = auth.uid()) THEN
    RAISE EXCEPTION 'Нет доступа к пакету' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(x ORDER BY x ->> 'file', (x ->> 'excel_row')::int NULLS FIRST)
    FROM (
      SELECT jsonb_build_object('psdc_id', p.id, 'file', p.source_filename, 'excel_row', i.excel_row,
                                'cell', i.cell, 'field', i.field, 'severity', i.severity, 'message', i.message) AS x
      FROM psdc p
      JOIN psdc_issues i ON i.psdc_id = p.id
      WHERE p.batch_id = p_batch_id AND p.state IN ('uploaded', 'validated', 'invalid')
        AND (p_severity IS NULL OR i.severity = p_severity)
      LIMIT 20000
    ) q
  ), '[]'::jsonb);
END;
$$;


ALTER FUNCTION public.psdc_batch_issues(p_batch_id uuid, p_severity text) OWNER TO postgres;

--
-- Name: psdc_batch_items(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_batch_items(p_batch_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NOT psdc_contracts_permission(true)
     AND NOT EXISTS (SELECT 1 FROM psdc_batches WHERE id = p_batch_id AND created_by = auth.uid()) THEN
    RAISE EXCEPTION 'Нет доступа к пакету' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', p.id, 'state', p.state, 'document_id', p.document_id, 'match_method', p.match_method,
      'match_note', p.match_note, 'source_filename', p.source_filename, 'source_size', p.source_size,
      'source_hash', p.source_hash, 'source_s3_document_id', p.source_s3_document_id,
      'uploaded_at', p.uploaded_at, 'applied_at', p.applied_at,
      'error_count', p.error_count, 'warning_count', p.warning_count,
      'section_count', p.section_count, 'process_count', p.process_count,
      'total', p.total::text, 'vat_amount', p.vat_amount::text,
      'document', CASE WHEN c.id IS NOT NULL THEN jsonb_build_object(
        'id', c.id, 'display_id', c.display_id, 'record_type', c.record_type, 'contract_number', c.contract_number,
        'status', c.status, 'deleted', c.deleted_at IS NOT NULL, 'counterparty', cp.name,
        'root_display_id', rc.display_id, 'root_contract_number', rc.contract_number) END,
      'lock_reason', CASE WHEN c.id IS NOT NULL THEN psdc_document_lock_reason(c) END,
      'document_has_applied', CASE WHEN c.id IS NOT NULL THEN EXISTS (
        SELECT 1 FROM psdc x WHERE x.document_id = c.id AND x.state = 'applied' AND x.id <> p.id) ELSE false END,
      'conflict', CASE WHEN p.document_id IS NOT NULL AND p.state IN ('uploaded', 'validated', 'invalid') THEN EXISTS (
        SELECT 1 FROM psdc x WHERE x.batch_id = p.batch_id AND x.document_id = p.document_id AND x.id <> p.id
          AND x.state IN ('uploaded', 'validated', 'invalid', 'applied')) ELSE false END,
      'duplicate_file', CASE WHEN p.source_hash IS NOT NULL THEN EXISTS (
        SELECT 1 FROM psdc x WHERE x.batch_id = p.batch_id AND x.source_hash = p.source_hash AND x.id <> p.id
          AND x.state <> 'cancelled') ELSE false END,
      'first_issues', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('severity', i.severity, 'excel_row', i.excel_row, 'cell', i.cell, 'message', i.message))
        FROM (SELECT * FROM psdc_issues WHERE psdc_id = p.id ORDER BY (severity = 'warning'), excel_row NULLS FIRST, id LIMIT 3) i
      ), '[]'::jsonb)
    ) ORDER BY p.source_filename, p.uploaded_at)
    FROM psdc p
    LEFT JOIN contracts c ON c.id = p.document_id
    LEFT JOIN counterparties cp ON cp.id = c.counterparty_id
    LEFT JOIN contracts rc ON rc.id = c.root_contract_id AND rc.id <> c.id
    WHERE p.batch_id = p_batch_id AND p.state <> 'cancelled'
  ), '[]'::jsonb);
END;
$$;


ALTER FUNCTION public.psdc_batch_items(p_batch_id uuid) OWNER TO postgres;

--
-- Name: psdc_batch_set_documents(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_batch_set_documents(p_items jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
  item jsonb;
  p psdc%ROWTYPE;
  doc contracts%ROWTYPE;
  v_doc_id uuid;
  v_method text;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF NOT psdc_contracts_permission(true) THEN
    RAISE EXCEPTION 'Недостаточно прав для загрузки ПСДЦ' USING ERRCODE = '42501';
  END IF;
  -- Сопоставление перепроверяет файл (НДС и ID строк зависят от документа),
  -- поэтому порции небольшие — запрос не должен упираться в statement_timeout.
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'За один запрос сопоставляется не более 100 файлов';
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    BEGIN
      SELECT * INTO p FROM psdc WHERE id = (item ->> 'psdc_id')::uuid FOR UPDATE;
      IF NOT FOUND OR p.batch_id IS NULL THEN
        RAISE EXCEPTION 'Файл пакета не найден';
      END IF;
      IF p.state NOT IN ('uploaded', 'validated', 'invalid') THEN
        RAISE EXCEPTION 'Файл уже применён или отменён — сопоставление не меняется';
      END IF;

      v_doc_id := NULL;
      IF COALESCE(item ->> 'document_id', '') <> '' THEN
        v_doc_id := (item ->> 'document_id')::uuid;
      ELSIF COALESCE(item ->> 'display_id', '') <> '' THEN
        IF (item ->> 'display_id') !~ '^[0-9]{1,15}$' THEN
          RAISE EXCEPTION 'Некорректный ID документа «%»', item ->> 'display_id';
        END IF;
        SELECT id INTO v_doc_id FROM contracts WHERE display_id = (item ->> 'display_id')::bigint;
        IF v_doc_id IS NULL THEN
          RAISE EXCEPTION 'Документ с ID % не найден', item ->> 'display_id';
        END IF;
      END IF;

      IF v_doc_id IS NOT NULL THEN
        SELECT * INTO doc FROM contracts WHERE id = v_doc_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Документ не найден';
        END IF;
        IF doc.deleted_at IS NOT NULL THEN
          RAISE EXCEPTION 'Документ ID % удалён', doc.display_id;
        END IF;
        IF NOT psdc_can_edit_document(doc.id) THEN
          RAISE EXCEPTION 'Нет доступа к документу ID %', doc.display_id USING ERRCODE = '42501';
        END IF;
      END IF;

      v_method := CASE WHEN v_doc_id IS NULL THEN NULL
                       WHEN item ->> 'method' IN ('auto', 'manual', 'table') THEN item ->> 'method'
                       ELSE 'manual' END;

      IF p.document_id IS DISTINCT FROM v_doc_id OR p.state = 'uploaded' THEN
        UPDATE psdc SET document_id = v_doc_id, match_method = v_method,
                        match_note = NULLIF(left(COALESCE(item ->> 'note', ''), 500), '')
        WHERE id = p.id;
        PERFORM psdc_validate_internal(p.id);
        IF v_doc_id IS NOT NULL THEN
          PERFORM psdc_audit(v_doc_id, 'psdc_uploaded',
            format('Файл ПСДЦ «%s» сопоставлен с документом при массовой загрузке (не применён)', p.source_filename),
            jsonb_build_object('psdc_id', p.id, 'batch_id', p.batch_id, 'method', v_method));
        END IF;
      ELSE
        UPDATE psdc SET match_method = v_method,
                        match_note = NULLIF(left(COALESCE(item ->> 'note', ''), 500), '')
        WHERE id = p.id;
      END IF;

      v_results := v_results || jsonb_build_object('psdc_id', p.id, 'ok', true);
    EXCEPTION WHEN others THEN
      v_results := v_results || jsonb_build_object('psdc_id', item ->> 'psdc_id', 'ok', false, 'error', SQLERRM);
    END;
  END LOOP;
  RETURN v_results;
END;
$_$;


ALTER FUNCTION public.psdc_batch_set_documents(p_items jsonb) OWNER TO postgres;

--
-- Name: psdc_batch_set_notes(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_batch_set_notes(p_items jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NOT psdc_contracts_permission(true) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 2000 THEN
    RAISE EXCEPTION 'Слишком много элементов';
  END IF;
  UPDATE psdc p SET match_note = NULLIF(left(COALESCE(e ->> 'note', ''), 500), '')
  FROM jsonb_array_elements(p_items) e
  WHERE p.id = (e ->> 'psdc_id')::uuid AND p.batch_id IS NOT NULL AND p.document_id IS NULL
    AND p.state IN ('uploaded', 'validated', 'invalid');
END;
$$;


ALTER FUNCTION public.psdc_batch_set_notes(p_items jsonb) OWNER TO postgres;

--
-- Name: psdc_can_edit_document(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_can_edit_document(p_document_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT psdc_contracts_permission(true)
     AND EXISTS (SELECT 1 FROM contracts c WHERE c.id = p_document_id AND psdc_object_in_scope(c.object_id));
$$;


ALTER FUNCTION public.psdc_can_edit_document(p_document_id uuid) OWNER TO postgres;

--
-- Name: psdc_can_view_document(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_can_view_document(p_document_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT psdc_contracts_permission(false)
     AND EXISTS (SELECT 1 FROM contracts c WHERE c.id = p_document_id AND psdc_object_in_scope(c.object_id));
$$;


ALTER FUNCTION public.psdc_can_view_document(p_document_id uuid) OWNER TO postgres;

--
-- Name: psdc_cancel(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_cancel(p_psdc_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  p psdc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ПСДЦ не найдена';
  END IF;
  IF p.state NOT IN ('uploaded', 'validated', 'invalid') THEN
    RAISE EXCEPTION 'Отменить можно только непримененную загрузку';
  END IF;
  IF p.document_id IS NOT NULL THEN
    IF NOT psdc_can_edit_document(p.document_id) THEN
      RAISE EXCEPTION 'Недостаточно прав для изменения документа' USING ERRCODE = '42501';
    END IF;
  ELSIF p.uploaded_by IS DISTINCT FROM auth.uid() AND NOT psdc_contracts_permission(true) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  PERFORM psdc_discard_internal(p.id);
  PERFORM psdc_audit(p.document_id, 'psdc_upload_cancelled', format('Отменена загрузка ПСДЦ «%s»', p.source_filename),
    jsonb_build_object('psdc_id', p.id));
END;
$$;


ALTER FUNCTION public.psdc_cancel(p_psdc_id uuid) OWNER TO postgres;

--
-- Name: psdc_cell_value(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_cell_value(p_cell jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_cell) IS DISTINCT FROM 'object' THEN NULL
    WHEN p_cell ->> 't' = 'n' THEN COALESCE(p_cell ->> 'w', p_cell ->> 'v')
    ELSE p_cell ->> 'v'
  END;
$$;


ALTER FUNCTION public.psdc_cell_value(p_cell jsonb) OWNER TO postgres;

--
-- Name: psdc_compare(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_compare(p_psdc_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  p psdc%ROWTYPE;
  v_prev uuid;
BEGIN
  IF NOT psdc_visible(p_psdc_id) THEN
    RAISE EXCEPTION 'ПСДЦ не найдена или нет доступа' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id;
  v_prev := COALESCE(p.previous_psdc_id, CASE WHEN p.document_id IS NOT NULL THEN psdc_find_previous(p.document_id) END);
  IF v_prev IS NULL OR v_prev = p.id THEN
    RETURN jsonb_build_object('previous', NULL, 'rows', '{}'::jsonb, 'removed', '[]'::jsonb);
  END IF;

  RETURN (
    WITH cur AS (
      SELECT r.*, lower(btrim(COALESCE(r.name, ''))) AS nname FROM psdc_rows r WHERE r.psdc_id = p.id
    ), prv AS (
      SELECT r.*, lower(btrim(COALESCE(r.name, ''))) AS nname FROM psdc_rows r WHERE r.psdc_id = v_prev
    ), by_id AS (
      SELECT c.id AS cur_id, pr.id AS prev_id
      FROM cur c JOIN prv pr ON pr.logical_line_id = c.logical_line_id
    ), cur_rest AS (
      SELECT c.id, COALESCE(c.number, '') AS knum, c.nname, c.row_kind,
             count(*) OVER (PARTITION BY COALESCE(c.number, ''), c.nname) AS cnt
      FROM cur c WHERE NOT EXISTS (SELECT 1 FROM by_id b WHERE b.cur_id = c.id)
    ), prv_rest AS (
      SELECT pr.id, COALESCE(pr.number, '') AS knum, pr.nname, pr.row_kind,
             count(*) OVER (PARTITION BY COALESCE(pr.number, ''), pr.nname) AS cnt
      FROM prv pr WHERE NOT EXISTS (SELECT 1 FROM by_id b WHERE b.prev_id = pr.id)
    ), by_key AS (
      -- Без ID строки пара признаётся только при однозначном совпадении.
      SELECT c.id AS cur_id, pr.id AS prev_id
      FROM cur_rest c
      JOIN prv_rest pr ON pr.knum = c.knum AND pr.nname = c.nname
                      AND pr.row_kind IS NOT DISTINCT FROM c.row_kind
      WHERE c.cnt = 1 AND pr.cnt = 1
    ), pairs AS (
      SELECT * FROM by_id UNION ALL SELECT * FROM by_key
    ), diffs AS (
      SELECT c.id,
        CASE WHEN pr.id IS NULL THEN 'new' ELSE 'matched' END AS status,
        CASE WHEN pr.id IS NULL THEN '[]'::jsonb ELSE (
          SELECT COALESCE(jsonb_agg(f), '[]'::jsonb) FROM (VALUES
            ('number', c.number IS DISTINCT FROM pr.number),
            ('resource_type', lower(c.resource_type) IS DISTINCT FROM lower(pr.resource_type)),
            ('code', c.code IS DISTINCT FROM pr.code),
            ('customer_material', c.is_customer_material IS DISTINCT FROM pr.is_customer_material),
            ('cost_item', c.cost_item IS DISTINCT FROM pr.cost_item),
            ('name', c.name IS DISTINCT FROM pr.name),
            ('unit', c.unit IS DISTINCT FROM pr.unit),
            ('consumption_norm', c.consumption_norm IS DISTINCT FROM pr.consumption_norm),
            ('volume', c.volume IS DISTINCT FROM pr.volume),
            ('material_price', c.material_price IS DISTINCT FROM pr.material_price),
            ('work_price', c.work_price IS DISTINCT FROM pr.work_price),
            ('material_cost', c.material_cost IS DISTINCT FROM pr.material_cost),
            ('work_cost', c.work_cost IS DISTINCT FROM pr.work_cost),
            ('total_cost', c.total_cost IS DISTINCT FROM pr.total_cost),
            ('manufacturer', c.manufacturer IS DISTINCT FROM pr.manufacturer),
            ('materials', c.materials IS DISTINCT FROM pr.materials),
            ('work_location', c.work_location IS DISTINCT FROM pr.work_location),
            ('comment', c.comment IS DISTINCT FROM pr.comment),
            ('legacy_deleted', c.legacy_deleted IS DISTINCT FROM pr.legacy_deleted)
          ) v(f, changed) WHERE v.changed) END AS fields
      FROM cur c
      LEFT JOIN pairs pa ON pa.cur_id = c.id
      LEFT JOIN prv pr ON pr.id = pa.prev_id
    )
    SELECT jsonb_build_object(
      'previous', (SELECT jsonb_build_object('id', pp.id, 'display_id', dc.display_id, 'record_type', dc.record_type,
                                             'total', pp.total::text, 'source_filename', pp.source_filename)
                   FROM psdc pp LEFT JOIN contracts dc ON dc.id = pp.document_id WHERE pp.id = v_prev),
      'rows', COALESCE((
        SELECT jsonb_object_agg(d.id, jsonb_build_object(
          'status', CASE WHEN d.status = 'new' THEN 'new' WHEN jsonb_array_length(d.fields) > 0 THEN 'changed' ELSE 'same' END,
          'fields', d.fields))
        FROM diffs d
      ), '{}'::jsonb),
      'removed', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('number', pr.number, 'name', pr.name, 'row_kind', pr.row_kind,
                                            'total_cost', pr.total_cost::text) ORDER BY pr.row_order)
        FROM prv pr WHERE NOT EXISTS (SELECT 1 FROM pairs pa WHERE pa.prev_id = pr.id)
      ), '[]'::jsonb)
    )
  );
END;
$$;


ALTER FUNCTION public.psdc_compare(p_psdc_id uuid) OWNER TO postgres;

--
-- Name: psdc_contracts_permission(boolean); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_contracts_permission(p_edit boolean) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role = ur.role AND rp.section = 'contracts'
      WHERE ur.user_id = auth.uid()
        AND ur.is_approved = true
        AND (to_jsonb(ur) ->> 'counterparty_id') IS NULL
        AND CASE WHEN p_edit THEN rp.can_edit ELSE rp.can_view END
    )
  );
$$;


ALTER FUNCTION public.psdc_contracts_permission(p_edit boolean) OWNER TO postgres;

--
-- Name: psdc_create(uuid, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_create(p_document_id uuid, p_batch_id uuid, p_meta jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  doc contracts%ROWTYPE;
  a record;
  v_reason text;
  v_id uuid;
  v_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Требуется вход в систему' USING ERRCODE = '42501';
  END IF;
  IF p_meta IS NULL OR jsonb_typeof(p_meta) <> 'object' OR pg_column_size(p_meta) > 200000 THEN
    RAISE EXCEPTION 'Некорректные сведения о файле';
  END IF;
  v_name := left(btrim(COALESCE(p_meta ->> 'source_filename', '')), 255);
  IF v_name = '' THEN
    RAISE EXCEPTION 'Не указано имя файла';
  END IF;

  IF p_document_id IS NOT NULL THEN
    SELECT * INTO doc FROM contracts WHERE id = p_document_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Документ не найден';
    END IF;
    v_reason := psdc_document_lock_reason(doc);
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION '%', v_reason USING ERRCODE = '42501';
    END IF;
    -- Новая загрузка из карточки заменяет предыдущую непримененную загрузку.
    PERFORM psdc_discard_internal(x.id)
    FROM psdc x
    WHERE x.document_id = doc.id AND x.batch_id IS NULL AND x.state IN ('uploaded', 'validated', 'invalid');
  ELSE
    IF p_batch_id IS NULL OR NOT EXISTS (SELECT 1 FROM psdc_batches WHERE id = p_batch_id) THEN
      RAISE EXCEPTION 'Пакет массовой загрузки не найден';
    END IF;
    IF NOT psdc_contracts_permission(true) THEN
      RAISE EXCEPTION 'Недостаточно прав для загрузки ПСДЦ' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT * INTO a FROM psdc_actor();
  INSERT INTO psdc (document_id, batch_id, state, match_method, source_filename, source_hash, source_size,
                    sheet_name, has_legacy_u, source_meta, uploaded_by, uploaded_by_name)
  VALUES (p_document_id, CASE WHEN p_document_id IS NULL THEN p_batch_id END, 'uploaded',
          CASE WHEN p_document_id IS NOT NULL THEN 'card' END,
          v_name, left(p_meta ->> 'source_hash', 128), NULLIF(p_meta ->> 'source_size', '')::bigint,
          left(p_meta ->> 'sheet_name', 120), COALESCE((p_meta ->> 'has_u')::boolean, false),
          jsonb_build_object(
            'header', COALESCE(p_meta -> 'header', '[]'::jsonb),
            'totals', COALESCE(p_meta -> 'totals', '{}'::jsonb),
            'fatal', COALESCE(p_meta -> 'fatal', '[]'::jsonb)),
          a.user_id, a.full_name)
  RETURNING id INTO v_id;

  IF p_document_id IS NOT NULL THEN
    PERFORM psdc_audit(p_document_id, 'psdc_uploaded', format('Загружена ПСДЦ «%s» (не применена)', v_name),
      jsonb_build_object('psdc_id', v_id, 'file', v_name));
  END IF;
  RETURN v_id;
END;
$$;


ALTER FUNCTION public.psdc_create(p_document_id uuid, p_batch_id uuid, p_meta jsonb) OWNER TO postgres;

--
-- Name: psdc_delete(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_delete(p_psdc_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  p psdc%ROWTYPE;
  doc contracts%ROWTYPE;
  a record;
  v_reason text;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ПСДЦ не найдена';
  END IF;
  IF p.state <> 'applied' THEN
    RAISE EXCEPTION 'Удалить можно только применённую ПСДЦ';
  END IF;
  SELECT * INTO doc FROM contracts WHERE id = p.document_id FOR UPDATE;
  v_reason := psdc_document_lock_reason(doc);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION '%', v_reason USING ERRCODE = '42501';
  END IF;

  SELECT * INTO a FROM psdc_actor();
  UPDATE psdc SET state = 'deleted', deleted_at = now(), deleted_by_name = a.full_name WHERE id = p.id;

  PERFORM set_config('osp.psdc_write', 'on', true);
  UPDATE contracts SET psdc_total = NULL, psdc_applied_id = NULL WHERE id = doc.id;
  PERFORM set_config('osp.psdc_write', 'off', true);

  PERFORM psdc_audit(doc.id, 'psdc_deleted',
    format('Удалена ПСДЦ «%s» (итог %s). Сумма документа — ручная: %s', p.source_filename, p.total::text,
      COALESCE(doc.contract_amount::text, 'не задана')),
    jsonb_build_object('psdc_id', p.id, 'total', p.total::text, 'manual_amount', doc.contract_amount::text));
END;
$$;


ALTER FUNCTION public.psdc_delete(p_psdc_id uuid) OWNER TO postgres;

--
-- Name: psdc_discard_internal(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_discard_internal(p_psdc_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  UPDATE psdc SET state = 'cancelled', cancelled_at = now() WHERE id = p_psdc_id;
  DELETE FROM psdc_issues WHERE psdc_id = p_psdc_id;
  DELETE FROM psdc_rows WHERE psdc_id = p_psdc_id;
  DELETE FROM psdc_source_rows WHERE psdc_id = p_psdc_id;
END;
$$;


ALTER FUNCTION public.psdc_discard_internal(p_psdc_id uuid) OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: contracts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contracts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_number character varying(100),
    contract_date date,
    object_id uuid,
    contract_amount numeric(15,2),
    warranty_retention_percent numeric(5,2),
    warranty_retention_period character varying(100),
    work_start_date date,
    work_end_date date,
    warranty_period character varying(100),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    counterparty_id uuid,
    status character varying(20) DEFAULT 'new_request'::character varying NOT NULL,
    tender_id uuid,
    document_link text,
    work_name text,
    responsible_contact_id uuid,
    deleted_at timestamp with time zone,
    notes text,
    currency character varying(3) DEFAULT 'RUB'::character varying NOT NULL,
    vat_rate numeric(5,2),
    amount_includes_vat boolean DEFAULT true NOT NULL,
    accepted_date date,
    signed_date date,
    concept_agreement_s3_document_id uuid,
    display_id bigint NOT NULL,
    record_type text DEFAULT 'dp'::text NOT NULL,
    parent_contract_id uuid,
    gen_director_name text,
    phone text,
    email text,
    bsm text,
    comments text,
    gp_amount numeric(15,2),
    handled_by_us boolean DEFAULT false NOT NULL,
    folder_path text,
    root_contract_id uuid,
    changed_fields text[] DEFAULT '{}'::text[] NOT NULL,
    psdc_total numeric(20,2),
    psdc_applied_id uuid,
    larix_entered boolean DEFAULT false NOT NULL,
    larix_number text,
    larix_entered_at timestamp with time zone,
    larix_entered_by text,
    signal_link text,
    CONSTRAINT contracts_contract_amount_check CHECK ((contract_amount >= (0)::numeric)),
    CONSTRAINT contracts_record_type_check CHECK ((record_type = ANY (ARRAY['dp'::text, 'ds_vor'::text, 'ds_extra'::text]))),
    CONSTRAINT contracts_warranty_retention_percent_check CHECK (((warranty_retention_percent >= (0)::numeric) AND (warranty_retention_percent <= (100)::numeric)))
);


ALTER TABLE public.contracts OWNER TO postgres;

--
-- Name: TABLE contracts; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.contracts IS 'Реестр договоров с подрядчиками';


--
-- Name: COLUMN contracts.id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.id IS 'Уникальный идентификатор договора';


--
-- Name: COLUMN contracts.contract_number; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.contract_number IS 'Номер договора (необязателен — может быть присвоен позже)';


--
-- Name: COLUMN contracts.contract_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.contract_date IS 'Дата заключения договора';


--
-- Name: COLUMN contracts.object_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.object_id IS 'Ссылка на объект строительства';


--
-- Name: COLUMN contracts.contract_amount; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.contract_amount IS 'Сумма по договору (рубли)';


--
-- Name: COLUMN contracts.warranty_retention_percent; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.warranty_retention_percent IS 'Процент гарантийных удержаний';


--
-- Name: COLUMN contracts.warranty_retention_period; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.warranty_retention_period IS 'Срок гарантийных удержаний';


--
-- Name: COLUMN contracts.work_start_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.work_start_date IS 'Дата начала работ';


--
-- Name: COLUMN contracts.work_end_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.work_end_date IS 'Дата окончания работ';


--
-- Name: COLUMN contracts.warranty_period; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.warranty_period IS 'Срок гарантии на выполненные работы';


--
-- Name: COLUMN contracts.created_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.created_at IS 'Дата и время создания записи';


--
-- Name: COLUMN contracts.updated_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.updated_at IS 'Дата и время последнего обновления записи';


--
-- Name: COLUMN contracts.counterparty_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.counterparty_id IS 'Ссылка на контрагента (подрядчика)';


--
-- Name: COLUMN contracts.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.status IS 'Статус договора (pending - на согласовании, signed - заключен)';


--
-- Name: COLUMN contracts.tender_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.tender_id IS 'Ссылка на тендер, по результатам которого заключается договор';


--
-- Name: COLUMN contracts.notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.notes IS 'Свободное примечание по договору, ведётся на странице деталей';


--
-- Name: COLUMN contracts.currency; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.currency IS 'Валюта договора (ISO 4217): RUB/CNY/USD/EUR';


--
-- Name: COLUMN contracts.vat_rate; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.vat_rate IS 'Ставка НДС договора, % (0/5/22/…); зависит от системы налогообложения контрагента';


--
-- Name: COLUMN contracts.amount_includes_vat; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.amount_includes_vat IS 'TRUE — суммы/цены заданы с НДС, FALSE — без НДС';


--
-- Name: COLUMN contracts.accepted_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.accepted_date IS 'Дата принятия договора в работу (ДП)';


--
-- Name: COLUMN contracts.signed_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.signed_date IS 'Дата подписания договора';


--
-- Name: COLUMN contracts.concept_agreement_s3_document_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.concept_agreement_s3_document_id IS 'Понятийное соглашение (S3-документ-основание для договора, с визой акционера)';


--
-- Name: COLUMN contracts.display_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.display_id IS 'Постоянный компактный ID портала (авто, уникален, не переиспользуется)';


--
-- Name: COLUMN contracts.record_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.record_type IS 'dp — основной договор; ds_vor — ДС на изменение ВОР (изменяет один документ своей ветки); ds_extra — ДС на дополнительные работы (новая ветка от договора)';


--
-- Name: COLUMN contracts.parent_contract_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.parent_contract_id IS 'Родительский договор для ДС (не является ID самого ДС)';


--
-- Name: COLUMN contracts.gen_director_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.gen_director_name IS 'ФИО генерального директора (свободный текст)';


--
-- Name: COLUMN contracts.phone; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.phone IS 'Телефон (свободный текст)';


--
-- Name: COLUMN contracts.email; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.email IS 'Email (свободный текст)';


--
-- Name: COLUMN contracts.bsm; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.bsm IS 'БСМ (свободный текст: да/нет/частично/любое)';


--
-- Name: COLUMN contracts.comments; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.comments IS 'Комментарии (свободный текст)';


--
-- Name: COLUMN contracts.gp_amount; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.gp_amount IS 'Сумма по договору генподряда (ДГП). Наценка = gp_amount / contract_amount, считается в UI';


--
-- Name: COLUMN contracts.handled_by_us; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.handled_by_us IS 'Договор ведёт наш отдел (ОСП). Разделяет реестр на «Все договоры» и «Наши договоры»';


--
-- Name: COLUMN contracts.folder_path; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.folder_path IS 'Путь к папке с документами договора в файловом хранилище (UNC или локальный). Показывается для копирования: браузер не может открыть проводник по клику';


--
-- Name: COLUMN contracts.root_contract_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.root_contract_id IS 'Корневой договор дерева документа; у самого договора равен его id. Заполняется триггером — нужен, чтобы реестр и уникальность номера ДС не требовали рекурсии на каждую строку';


--
-- Name: COLUMN contracts.changed_fields; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.changed_fields IS 'Какие коммерческие поля ДС реально меняет. Остальные наследуются от предыдущей актуальной версии ветки. Пустое значение поля НЕ означает изменение — иначе ДС молча возвращал бы старые условия';


--
-- Name: COLUMN contracts.psdc_total; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.psdc_total IS 'Итог применённой ПСДЦ документа. Пока задан, он и есть сумма документа; ручная contract_amount сохраняется и снова действует после удаления ПСДЦ. Пишется только функциями psdc_apply / psdc_delete';


--
-- Name: COLUMN contracts.psdc_applied_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.psdc_applied_id IS 'Применённая ПСДЦ документа (psdc.id)';


--
-- Name: COLUMN contracts.larix_entered; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.larix_entered IS 'Договор внесён в систему Larix';


--
-- Name: COLUMN contracts.larix_number; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.larix_number IS 'Номер договора в системе Larix';


--
-- Name: COLUMN contracts.larix_entered_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.larix_entered_at IS 'Когда отмечено внесение в Larix';


--
-- Name: COLUMN contracts.larix_entered_by; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.larix_entered_by IS 'Кто отметил внесение в Larix (ФИО/e-mail)';


--
-- Name: COLUMN contracts.signal_link; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contracts.signal_link IS 'Путь к Signal: ссылка (или путь) на документы договора в общем хранилище. http(s) открывается кликом, прочее — копируется';


--
-- Name: psdc_document_lock_reason(public.contracts); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_document_lock_reason(p_doc public.contracts) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    BEGIN
      IF p_doc.id IS NULL THEN
        RETURN 'Документ не найден';
      END IF;
      IF p_doc.deleted_at IS NOT NULL THEN
        RETURN format('Документ ID %s удалён', p_doc.display_id);
      END IF;
      IF NOT psdc_can_edit_document(p_doc.id) THEN
        RETURN 'Недостаточно прав для изменения документа';
      END IF;
      -- Статус документа ПСДЦ больше не блокирует: завершённый договор или ДС
      -- принимают новую ведомость без возврата на доработку.
      RETURN NULL;
    END;
    $$;


ALTER FUNCTION public.psdc_document_lock_reason(p_doc public.contracts) OWNER TO postgres;

--
-- Name: psdc_document_state(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_document_state(p_document_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  doc contracts%ROWTYPE;
  v_applied uuid;
  v_staging uuid;
  v_prev uuid;
  v_rate numeric;
  v_incl boolean;
BEGIN
  SELECT * INTO doc FROM contracts WHERE id = p_document_id;
  IF NOT FOUND OR NOT psdc_can_view_document(p_document_id) THEN
    RAISE EXCEPTION 'Документ не найден или нет доступа' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_applied FROM psdc WHERE document_id = doc.id AND state = 'applied';
  SELECT id INTO v_staging FROM psdc
  WHERE document_id = doc.id AND batch_id IS NULL AND state IN ('uploaded', 'validated', 'invalid')
  ORDER BY uploaded_at DESC LIMIT 1;
  v_prev := psdc_find_previous(doc.id);
  SELECT rate, includes INTO v_rate, v_incl FROM psdc_document_vat(doc.id);

  RETURN jsonb_build_object(
    'document', jsonb_build_object(
      'id', doc.id, 'display_id', doc.display_id, 'record_type', doc.record_type, 'status', doc.status,
      'manual_amount', doc.contract_amount::text, 'psdc_total', doc.psdc_total::text,
      'vat_rate', v_rate::text, 'vat_included', v_incl),
    'can_edit', psdc_can_edit_document(doc.id),
    'lock_reason', psdc_document_lock_reason(doc),
    'applied', CASE WHEN v_applied IS NOT NULL THEN psdc_json(v_applied, 0) END,
    'staging', CASE WHEN v_staging IS NOT NULL THEN psdc_json(v_staging, 1000) END,
    'previous', CASE WHEN v_prev IS NOT NULL THEN (
      SELECT jsonb_build_object('id', pp.id, 'document_id', pp.document_id, 'display_id', c.display_id,
                                'record_type', c.record_type, 'total', pp.total::text)
      FROM psdc pp JOIN contracts c ON c.id = pp.document_id WHERE pp.id = v_prev) END,
    'pending_batch_files', (
      SELECT count(*) FROM psdc WHERE document_id = doc.id AND batch_id IS NOT NULL
        AND state IN ('uploaded', 'validated', 'invalid'))
  );
END;
$$;


ALTER FUNCTION public.psdc_document_state(p_document_id uuid) OWNER TO postgres;

--
-- Name: psdc_document_vat(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_document_vat(p_document_id uuid, OUT rate numeric, OUT includes boolean) RETURNS record
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  cur contracts%ROWTYPE;
  guard int := 0;
  rate_done boolean := false;
  incl_done boolean := false;
BEGIN
  SELECT * INTO cur FROM contracts WHERE id = p_document_id;
  WHILE FOUND AND guard < 1000 AND NOT (rate_done AND incl_done) LOOP
    guard := guard + 1;
    IF cur.record_type IN ('dp', 'ds_extra') OR cur.parent_contract_id IS NULL THEN
      IF NOT rate_done THEN rate := cur.vat_rate; rate_done := true; END IF;
      IF NOT incl_done THEN includes := cur.amount_includes_vat; incl_done := true; END IF;
      EXIT;
    END IF;
    IF NOT rate_done AND 'vat_rate' = ANY (COALESCE(cur.changed_fields, '{}')) THEN
      rate := cur.vat_rate; rate_done := true;
    END IF;
    IF NOT incl_done AND 'amount_includes_vat' = ANY (COALESCE(cur.changed_fields, '{}')) THEN
      includes := cur.amount_includes_vat; incl_done := true;
    END IF;
    SELECT * INTO cur FROM contracts WHERE id = cur.parent_contract_id;
  END LOOP;
  includes := COALESCE(includes, true);
END;
$$;


ALTER FUNCTION public.psdc_document_vat(p_document_id uuid, OUT rate numeric, OUT includes boolean) OWNER TO postgres;

--
-- Name: psdc_feature_started_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_feature_started_at() RETURNS timestamp with time zone
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT '2026-09-11 12:13:58.574738+00'::timestamptz $$;


ALTER FUNCTION public.psdc_feature_started_at() OWNER TO postgres;

--
-- Name: psdc_find_previous(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_find_previous(p_document_id uuid) RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  doc contracts%ROWTYPE;
  cur contracts%ROWTYPE;
  found_id uuid;
  guard int := 0;
BEGIN
  SELECT * INTO doc FROM contracts WHERE id = p_document_id;
  IF NOT FOUND OR doc.record_type <> 'ds_vor' OR doc.parent_contract_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO cur FROM contracts WHERE id = doc.parent_contract_id;
  WHILE FOUND AND guard < 1000 LOOP
    guard := guard + 1;
    SELECT p.id INTO found_id FROM psdc p WHERE p.document_id = cur.id AND p.state = 'applied';
    IF found_id IS NOT NULL THEN
      RETURN found_id;
    END IF;
    IF cur.record_type IN ('dp', 'ds_extra') OR cur.parent_contract_id IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT * INTO cur FROM contracts WHERE id = cur.parent_contract_id;
  END LOOP;
  RETURN NULL;
END;
$$;


ALTER FUNCTION public.psdc_find_previous(p_document_id uuid) OWNER TO postgres;

--
-- Name: psdc_get(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_get(p_psdc_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NOT psdc_visible(p_psdc_id) THEN
    RAISE EXCEPTION 'ПСДЦ не найдена или нет доступа' USING ERRCODE = '42501';
  END IF;
  RETURN psdc_json(p_psdc_id, 5000);
END;
$$;


ALTER FUNCTION public.psdc_get(p_psdc_id uuid) OWNER TO postgres;

--
-- Name: psdc_get_rows(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_get_rows(p_psdc_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NOT psdc_visible(p_psdc_id) THEN
    RAISE EXCEPTION 'ПСДЦ не найдена или нет доступа' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'logical_line_id', r.logical_line_id, 'row_order', r.row_order, 'excel_row', r.excel_row,
      'row_kind', r.row_kind, 'number', r.number, 'resource_type', r.resource_type, 'code', r.code,
      'customer_material', r.customer_material, 'is_customer_material', r.is_customer_material,
      'cost_item', r.cost_item, 'name', r.name, 'unit', r.unit,
      'consumption_norm', r.consumption_norm::text, 'volume', r.volume::text,
      'material_price', r.material_price::text, 'material_cost', r.material_cost::text,
      'work_price', r.work_price::text, 'work_cost', r.work_cost::text,
      'unit_price', r.unit_price::text, 'total_cost', r.total_cost::text,
      'manufacturer', r.manufacturer, 'materials', r.materials, 'work_location', r.work_location,
      'comment', r.comment, 'parent_section_id', r.parent_section_id, 'legacy_deleted', r.legacy_deleted
    ) ORDER BY r.row_order)
    FROM psdc_rows r
    WHERE r.psdc_id = p_psdc_id
  ), '[]'::jsonb);
END;
$$;


ALTER FUNCTION public.psdc_get_rows(p_psdc_id uuid) OWNER TO postgres;

--
-- Name: psdc_json(uuid, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_json(p_psdc_id uuid, p_issue_limit integer DEFAULT 500) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT jsonb_build_object(
    'id', p.id,
    'document_id', p.document_id,
    'batch_id', p.batch_id,
    'state', p.state,
    'previous_psdc_id', p.previous_psdc_id,
    'match_method', p.match_method,
    'match_note', p.match_note,
    'source_filename', p.source_filename,
    'source_size', p.source_size,
    'source_hash', p.source_hash,
    'source_s3_document_id', p.source_s3_document_id,
    'sheet_name', p.sheet_name,
    'has_legacy_u', p.has_legacy_u,
    'uploaded_by_name', p.uploaded_by_name,
    'uploaded_at', p.uploaded_at,
    'validated_at', p.validated_at,
    'applied_at', p.applied_at,
    'applied_by_name', p.applied_by_name,
    'deleted_at', p.deleted_at,
    'section_count', p.section_count,
    'process_count', p.process_count,
    'legacy_deleted_count', p.legacy_deleted_count,
    'error_count', p.error_count,
    'warning_count', p.warning_count,
    'total_material', p.total_material::text,
    'total_work', p.total_work::text,
    'total', p.total::text,
    'dm_material_excluded', p.dm_material_excluded::text,
    'vat_rate', p.vat_rate_snapshot::text,
    'vat_included', p.vat_included_snapshot,
    'vat_amount', p.vat_amount::text,
    'file_vat_rate', p.file_vat_rate::text,
    'legacy_total', p.legacy_total::text,
    'issues', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'severity', i.severity, 'excel_row', i.excel_row, 'cell', i.cell,
               'field', i.field, 'code', i.code, 'message', i.message)
             ORDER BY (i.severity = 'warning'), i.excel_row NULLS FIRST, i.id)
      FROM (
        SELECT * FROM psdc_issues WHERE psdc_id = p.id
        ORDER BY (severity = 'warning'), excel_row NULLS FIRST, id
        LIMIT GREATEST(p_issue_limit, 0)
      ) i
    ), '[]'::jsonb)
  )
  FROM psdc p
  WHERE p.id = p_psdc_id;
$$;


ALTER FUNCTION public.psdc_json(p_psdc_id uuid, p_issue_limit integer) OWNER TO postgres;

--
-- Name: psdc_log_export(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_log_export(p_psdc_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  p psdc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id;
  IF NOT FOUND OR NOT psdc_visible(p_psdc_id) THEN
    RAISE EXCEPTION 'ПСДЦ не найдена или нет доступа' USING ERRCODE = '42501';
  END IF;
  PERFORM psdc_audit(p.document_id, 'psdc_exported', format('Экспорт ПСДЦ «%s»', p.source_filename),
    jsonb_build_object('psdc_id', p.id));
END;
$$;


ALTER FUNCTION public.psdc_log_export(p_psdc_id uuid) OWNER TO postgres;

--
-- Name: psdc_norm_header(text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_norm_header(p_text text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT lower(btrim(regexp_replace(translate(COALESCE(p_text, ''), 'ёЁ', 'еЕ'),
                                    '[[:space:]' || chr(160) || chr(8199) || chr(8239) || ']+', ' ', 'g')));
$$;


ALTER FUNCTION public.psdc_norm_header(p_text text) OWNER TO postgres;

--
-- Name: psdc_number_message(text, text, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_number_message(p_label text, p_err text, p_raw text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE p_err
    WHEN 'formula_no_value' THEN format('%s: в ячейке формула без сохранённого числового значения', p_label)
    WHEN 'excel_error' THEN format('%s: ошибка Excel в ячейке (%s)', p_label, COALESCE(p_raw, '—'))
    WHEN 'too_large' THEN format('%s: слишком большое значение', p_label)
    ELSE format('%s: некорректное число «%s»', p_label, left(COALESCE(p_raw, ''), 60))
  END;
$$;


ALTER FUNCTION public.psdc_number_message(p_label text, p_err text, p_raw text) OWNER TO postgres;

--
-- Name: psdc_object_in_scope(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_object_in_scope(p_object_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT public.is_admin() OR COALESCE((
    SELECT CASE
      WHEN jsonb_typeof(to_jsonb(ur) -> 'object_ids') = 'array'
           AND jsonb_array_length(to_jsonb(ur) -> 'object_ids') > 0
        THEN p_object_id IS NOT NULL AND (to_jsonb(ur) -> 'object_ids') ? p_object_id::text
      WHEN (to_jsonb(ur) ->> 'object_id') IS NOT NULL
        THEN p_object_id IS NOT NULL AND p_object_id::text = to_jsonb(ur) ->> 'object_id'
      ELSE true
    END
    FROM user_roles ur
    WHERE ur.user_id = auth.uid()
    LIMIT 1
  ), false);
$$;


ALTER FUNCTION public.psdc_object_in_scope(p_object_id uuid) OWNER TO postgres;

--
-- Name: psdc_parse_decimal(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_parse_decimal(p_cell jsonb) RETURNS TABLE(val numeric, err text, warn text)
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT
    CASE WHEN x.e IS NULL THEN x.num END,
    x.e,
    CASE WHEN x.e IS NULL AND x.num IS NOT NULL AND x.f THEN 'formula' END
  FROM (
    SELECT q.f, CASE WHEN q.big THEN NULL ELSE q.num END AS num,
      CASE
        WHEN NOT q.obj THEN NULL
        WHEN q.f AND NOT (q.t = 'n' AND q.ok) THEN 'formula_no_value'
        WHEN q.t = 'e' THEN 'excel_error'
        WHEN q.s IS NULL OR q.s = '' THEN NULL
        WHEN NOT q.ok THEN 'not_number'
        WHEN q.big THEN 'too_large'
      END AS e
    FROM (
      SELECT r.*, COALESCE(abs(r.num) >= 1000000000000000, false) AS big
      FROM (
        SELECT y.*, CASE WHEN y.ok THEN y.s::numeric END AS num
        FROM (
          SELECT z.*,
            COALESCE(z.s <> '' AND z.s ~ CASE WHEN z.t = 'n'
              THEN '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$'
              ELSE '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$' END, false) AS ok
          FROM (
            SELECT
              COALESCE(jsonb_typeof(p_cell) = 'object', false) AS obj,
              COALESCE(p_cell ->> 't', '') AS t,
              COALESCE(p_cell ->> 'f', '') IN ('1', 'true') AS f,
              CASE
                WHEN jsonb_typeof(p_cell) IS DISTINCT FROM 'object' OR p_cell ->> 'v' IS NULL OR p_cell ->> 't' = 'e' THEN NULL
                WHEN p_cell ->> 't' = 'n' THEN p_cell ->> 'v'
                WHEN COALESCE(p_cell ->> 'f', '') IN ('1', 'true') THEN NULL
                ELSE replace(regexp_replace(p_cell ->> 'v', '[[:space:]' || chr(160) || chr(8199) || chr(8239) || ']', '', 'g'), ',', '.')
              END AS s
            OFFSET 0
          ) z
          OFFSET 0
        ) y
        OFFSET 0
      ) r
      OFFSET 0
    ) q
  ) x;
$_$;


ALTER FUNCTION public.psdc_parse_decimal(p_cell jsonb) OWNER TO postgres;

--
-- Name: psdc_set_source_file(uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_set_source_file(p_psdc_id uuid, p_s3_document_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  p psdc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id FOR UPDATE;
  IF NOT FOUND OR p.uploaded_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ПСДЦ не найдена' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM s3_documents d
    WHERE d.id = p_s3_document_id AND d.owner_type = 'general' AND d.owner_id = p.id
  ) THEN
    RAISE EXCEPTION 'Файл-источник не относится к этой ПСДЦ';
  END IF;
  UPDATE psdc SET source_s3_document_id = p_s3_document_id WHERE id = p.id;
END;
$$;


ALTER FUNCTION public.psdc_set_source_file(p_psdc_id uuid, p_s3_document_id uuid) OWNER TO postgres;

--
-- Name: psdc_validate(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_validate(p_psdc_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  p psdc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ПСДЦ не найдена';
  END IF;
  IF p.document_id IS NOT NULL THEN
    IF NOT psdc_can_edit_document(p.document_id) THEN
      RAISE EXCEPTION 'Недостаточно прав для изменения документа' USING ERRCODE = '42501';
    END IF;
  ELSIF p.uploaded_by IS DISTINCT FROM auth.uid() AND NOT psdc_contracts_permission(true) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF p.state NOT IN ('uploaded', 'validated', 'invalid') THEN
    RAISE EXCEPTION 'Проверять можно только непримененную загрузку';
  END IF;

  PERFORM psdc_validate_internal(p.id);
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id;

  IF p.document_id IS NOT NULL THEN
    PERFORM psdc_audit(p.document_id, 'psdc_validated',
      format('Проверена ПСДЦ «%s»: %s', p.source_filename,
        CASE WHEN p.error_count > 0 THEN format('ошибок %s', p.error_count)
             ELSE format('итого %s', p.total::text) END),
      jsonb_build_object('psdc_id', p.id, 'errors', p.error_count, 'warnings', p.warning_count, 'total', p.total::text));
  END IF;
  RETURN psdc_json(p.id, 1000);
END;
$$;


ALTER FUNCTION public.psdc_validate(p_psdc_id uuid) OWNER TO postgres;

--
-- Name: psdc_validate_internal(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_validate_internal(p_psdc_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  p psdc%ROWTYPE;
  canon CONSTANT text[] := ARRAY[
    '№ п/п', 'Тип ресурса', 'Шифр', 'Давальческий материал', 'Статья затрат',
    'Наименование работы', 'Ед. изм.', 'Норма расхода', 'Объём', 'Цена за материал',
    'Стоимость за материал', 'Цена за работу', 'Стоимость за работу', 'Единичная расценка',
    'Общая стоимость', 'Завод-изготовитель', 'Применяемые материалы',
    'Место проведения работ', 'Комментарий', 'ID строки в системе'];
  cap CONSTANT int := 300;
  hdr jsonb;
  v_col int;
  v_prev uuid;
  v_rate numeric;
  v_incl boolean;
  v_tm numeric;
  v_tw numeric;
  v_t numeric;
  v_sum_o numeric;
  v_dm numeric;
  v_errors int;
  v_warnings int;
  v_cnt int;
  v_legacy record;
  v_file_rate numeric;
  v_vat numeric;
  v_sections int;
  v_processes int;
  v_deleted int;
  v_missing_t int;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ПСДЦ не найдена';
  END IF;

  DELETE FROM psdc_issues WHERE psdc_id = p.id;
  DELETE FROM psdc_rows WHERE psdc_id = p.id;

  -- Ошибки уровня файла, найденные при чтении XLSX (не читается, нет листа…).
  INSERT INTO psdc_issues (psdc_id, severity, code, message)
  SELECT p.id, 'error', 'file', m
  FROM jsonb_array_elements_text(COALESCE(p.source_meta -> 'fatal', '[]'::jsonb)) m;

  -- Шапка A:T. Порядок и названия не меняются, лишних обязательных столбцов нет.
  IF NOT EXISTS (SELECT 1 FROM psdc_issues WHERE psdc_id = p.id) THEN
    hdr := COALESCE(p.source_meta -> 'header', '[]'::jsonb);
    FOR v_col IN 1..20 LOOP
      IF psdc_norm_header(hdr ->> (v_col - 1)) IS DISTINCT FROM psdc_norm_header(canon[v_col]) THEN
        INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
        VALUES (p.id, 'error', 1, chr(64 + v_col) || '1', canon[v_col], 'header',
          format('Заголовок столбца %s должен быть «%s»%s', chr(64 + v_col), canon[v_col],
            CASE WHEN COALESCE(btrim(hdr ->> (v_col - 1)), '') = '' THEN ' — ячейка пуста'
                 ELSE format(' — в файле «%s»', left(btrim(hdr ->> (v_col - 1)), 80)) END));
      END IF;
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM psdc_issues WHERE psdc_id = p.id AND severity = 'error') THEN
    -- Со сдвинутыми столбцами разбирать строки бессмысленно: ошибки были бы мусором.
    UPDATE psdc SET
      state = 'invalid', validated_at = now(),
      error_count = (SELECT count(*) FROM psdc_issues WHERE psdc_id = p.id AND severity = 'error'),
      warning_count = 0, section_count = NULL, process_count = NULL, legacy_deleted_count = NULL,
      total_material = NULL, total_work = NULL, total = NULL, dm_material_excluded = NULL,
      vat_rate_snapshot = NULL, vat_included_snapshot = NULL, vat_amount = NULL
    WHERE id = p.id;
    RETURN;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS psdc_work (
    row_id uuid, row_order int, excel_row int,
    num text, rtype text, kind text, is_dm boolean, is_deleted boolean,
    code text, dm_text text, cost_item text, name text, unit text,
    manufacturer text, materials text, work_location text, comment text,
    h_raw text, i_raw text, j_raw text, l_raw text,
    h numeric, h_e text, h_w text,
    i numeric, i_e text, i_w text,
    j numeric, j_e text, j_w text,
    l numeric, l_e text, l_w text,
    ck numeric, cm numeric, cn numeric, co numeric,
    t_ref text, prefixes text[], logical_id text, parent_id uuid,
    k numeric, m numeric, n numeric, o numeric
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.psdc_work;

  -- Разбор строк и расчёт процессов одним проходом. Ячейки строки извлекаются
  -- из JSONB один раз; префиксы номера («5.1.10» → «5», «5.1») считаются здесь же
  -- и дальше служат и привязке к секции, и итогам секций.
  --   K = ROUND(ROUND(I,5) × ROUND(J,2), 2);   M = ROUND(ROUND(I,5) × ROUND(L,2), 2)
  --   N = ROUND(ROUND(J,2) + ROUND(L,2), 2);   O = M при ДМ, иначе ROUND(K + M, 2)
  INSERT INTO pg_temp.psdc_work (
    row_id, row_order, excel_row, num, rtype, kind, is_dm, is_deleted,
    code, dm_text, cost_item, name, unit, manufacturer, materials, work_location, comment,
    h_raw, i_raw, j_raw, l_raw,
    h, h_e, h_w, i, i_e, i_w, j, j_e, j_w, l, l_e, l_w,
    ck, cm, cn, co, t_ref, prefixes, k, m, n, o)
  SELECT
    b.row_id, b.row_order, b.excel_row, b.num, b.rtype, b.kind, b.is_dm, b.is_deleted,
    b.code, b.dm_text, b.cost_item, b.name, b.unit, b.manufacturer, b.materials, b.work_location, b.comment,
    b.h_raw, b.i_raw, b.j_raw, b.l_raw,
    b.h, b.h_e, b.h_w, b.i, b.i_e, b.i_w, b.j, b.j_e, b.j_w, b.l, b.l_e, b.l_w,
    b.ck, b.cm, b.cn, b.co, b.t_ref, b.prefixes,
    b.k, b.m, b.n,
    CASE WHEN b.k IS NOT NULL THEN CASE WHEN b.is_dm THEN b.m ELSE round(b.k + b.m, 2) END END
  FROM (
    SELECT a.*,
      CASE WHEN a.calc THEN round(round(a.i, 5) * round(COALESCE(a.j, 0), 2), 2) END AS k,
      CASE WHEN a.calc THEN round(round(a.i, 5) * round(COALESCE(a.l, 0), 2), 2) END AS m,
      CASE WHEN a.calc THEN round(round(COALESCE(a.j, 0), 2) + round(COALESCE(a.l, 0), 2), 2) END AS n
    FROM (
      SELECT
        gen_random_uuid() AS row_id,
        (row_number() OVER (ORDER BY s.excel_row))::int AS row_order,
        s.excel_row,
        t.num, t.rtype, t.kind, t.is_dm, t.is_deleted,
        t.code, t.dm_text, t.cost_item, t.name, t.unit, t.manufacturer, t.materials, t.work_location, t.comment,
        t.h_raw, t.i_raw, t.j_raw, t.l_raw,
        hh.val AS h, hh.err AS h_e, hh.warn AS h_w,
        ii.val AS i, ii.err AS i_e, ii.warn AS i_w,
        jj.val AS j, jj.err AS j_e, jj.warn AS j_w,
        ll.val AS l, ll.err AS l_e, ll.warn AS l_w,
        kk.val AS ck, mm.val AS cm, nn.val AS cn, oo.val AS co,
        t.t_ref,
        CASE WHEN t.num IS NULL OR strpos(t.num, '.') = 0 THEN '{}'::text[]
             ELSE ARRAY(SELECT array_to_string(t.parts[1:g], '.') FROM generate_series(1, cardinality(t.parts) - 1) g ORDER BY g)
        END AS prefixes,
        (t.kind = 'process' AND NOT t.is_deleted AND ii.val IS NOT NULL
          AND ii.err IS NULL AND jj.err IS NULL AND ll.err IS NULL) AS calc
      FROM psdc_source_rows s
      CROSS JOIN LATERAL jsonb_to_record(s.cells) AS c(
        "A" jsonb, "B" jsonb, "C" jsonb, "D" jsonb, "E" jsonb, "F" jsonb, "G" jsonb, "H" jsonb, "I" jsonb, "J" jsonb,
        "K" jsonb, "L" jsonb, "M" jsonb, "N" jsonb, "O" jsonb, "P" jsonb, "Q" jsonb, "R" jsonb, "S" jsonb, "T" jsonb, "U" jsonb)
      CROSS JOIN LATERAL (
        SELECT v.*,
          CASE lower(COALESCE(v.rtype, ''))
            WHEN 'секция' THEN 'section'
            WHEN 'комплексный процесс' THEN 'process'
          END AS kind,
          lower(COALESCE(v.dm_text, '')) = 'дм' AS is_dm,
          p.has_legacy_u AND lower(btrim(COALESCE(v.u_raw, ''))) = 'deleted' AS is_deleted,
          string_to_array(v.num, '.') AS parts
        FROM (
          SELECT
            NULLIF(btrim(psdc_cell_value(c."A")), '') AS num,
            NULLIF(btrim(psdc_cell_value(c."B")), '') AS rtype,
            NULLIF(psdc_cell_value(c."C"), '') AS code,
            NULLIF(btrim(psdc_cell_value(c."D")), '') AS dm_text,
            NULLIF(psdc_cell_value(c."E"), '') AS cost_item,
            NULLIF(psdc_cell_value(c."F"), '') AS name,
            NULLIF(psdc_cell_value(c."G"), '') AS unit,
            NULLIF(psdc_cell_value(c."P"), '') AS manufacturer,
            NULLIF(psdc_cell_value(c."Q"), '') AS materials,
            NULLIF(psdc_cell_value(c."R"), '') AS work_location,
            NULLIF(psdc_cell_value(c."S"), '') AS comment,
            psdc_cell_value(c."H") AS h_raw,
            psdc_cell_value(c."I") AS i_raw,
            psdc_cell_value(c."J") AS j_raw,
            psdc_cell_value(c."L") AS l_raw,
            psdc_cell_value(c."U") AS u_raw,
            NULLIF(btrim(psdc_cell_value(c."T")), '') AS t_ref
          OFFSET 0
        ) v
        OFFSET 0
      ) t
      CROSS JOIN LATERAL psdc_parse_decimal(c."H") hh
      CROSS JOIN LATERAL psdc_parse_decimal(c."I") ii
      CROSS JOIN LATERAL psdc_parse_decimal(c."J") jj
      CROSS JOIN LATERAL psdc_parse_decimal(c."L") ll
      CROSS JOIN LATERAL psdc_parse_decimal(c."K") kk
      CROSS JOIN LATERAL psdc_parse_decimal(c."M") mm
      CROSS JOIN LATERAL psdc_parse_decimal(c."N") nn
      CROSS JOIN LATERAL psdc_parse_decimal(c."O") oo
      WHERE s.psdc_id = p.id
    ) a
  ) b;

  CREATE INDEX IF NOT EXISTS psdc_work_num_idx ON pg_temp.psdc_work (num);
  ANALYZE pg_temp.psdc_work;

  -- Тип строки.
  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, CASE WHEN w.is_deleted THEN 'warning' ELSE 'error' END, w.excel_row, 'B' || w.excel_row, 'Тип ресурса',
    'resource_type',
    CASE WHEN w.rtype IS NULL THEN 'Не указан тип ресурса' ELSE format('Неизвестный тип ресурса «%s»', left(w.rtype, 60)) END
      || CASE WHEN w.is_deleted THEN ' (строка помечена deleted)' ELSE '' END
  FROM pg_temp.psdc_work w
  WHERE w.kind IS NULL;

  -- Числовые исходные поля процесса.
  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, CASE WHEN w.is_deleted THEN 'warning' ELSE 'error' END, w.excel_row, x.col || w.excel_row, x.label,
    'number',
    psdc_number_message(x.label, x.err, x.raw)
      || CASE WHEN w.is_deleted THEN ' (строка помечена deleted и не участвует в расчёте)' ELSE '' END
  FROM pg_temp.psdc_work w
  CROSS JOIN LATERAL (VALUES
    ('H', 'Норма расхода', w.h_e, w.h_raw), ('I', 'Объём', w.i_e, w.i_raw),
    ('J', 'Цена за материал', w.j_e, w.j_raw), ('L', 'Цена за работу', w.l_e, w.l_raw)) x(col, label, err, raw)
  WHERE w.kind = 'process' AND x.err IS NOT NULL;

  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'warning', w.excel_row, x.col || w.excel_row, x.label, 'source_formula',
    format('%s: в исходной ячейке формула — формула не исполняется, использовано сохранённое значение %s', x.label, x.val::text)
  FROM pg_temp.psdc_work w
  CROSS JOIN LATERAL (VALUES
    ('H', 'Норма расхода', w.h_w, w.h), ('I', 'Объём', w.i_w, w.i),
    ('J', 'Цена за материал', w.j_w, w.j), ('L', 'Цена за работу', w.l_w, w.l)) x(col, label, wrn, val)
  WHERE w.kind = 'process' AND NOT w.is_deleted AND x.wrn = 'formula';

  -- Обязательные поля активной секции.
  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'error', w.excel_row, x.col || w.excel_row, x.label, 'required', x.msg
  FROM pg_temp.psdc_work w
  CROSS JOIN LATERAL (VALUES
    ('A', '№ п/п', '№ п/п секции не заполнен', w.num IS NULL),
    ('F', 'Наименование', 'Не заполнено наименование секции', COALESCE(btrim(w.name), '') = '')
  ) x(col, label, msg, bad)
  WHERE w.kind = 'section' AND NOT w.is_deleted AND x.bad;

  -- Обязательные поля активного процесса.
  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'error', w.excel_row, x.col || w.excel_row, x.label, 'required', x.msg
  FROM pg_temp.psdc_work w
  CROSS JOIN LATERAL (VALUES
    ('A', '№ п/п', '№ п/п процесса не заполнен', w.num IS NULL),
    ('F', 'Наименование', 'Не заполнено наименование работы', COALESCE(btrim(w.name), '') = ''),
    ('G', 'Ед. изм.', 'Не заполнена единица измерения', COALESCE(btrim(w.unit), '') = ''),
    ('I', 'Объём', 'Не заполнен объём', w.i IS NULL AND w.i_e IS NULL)
  ) x(col, label, msg, bad)
  WHERE w.kind = 'process' AND NOT w.is_deleted AND x.bad;

  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'error', w.excel_row, 'I' || w.excel_row, 'Объём', 'volume_negative', 'Некорректный объём: значение отрицательное'
  FROM pg_temp.psdc_work w
  WHERE w.kind = 'process' AND NOT w.is_deleted AND w.i < 0;

  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'warning', w.excel_row, 'I' || w.excel_row, 'Объём', 'volume_zero', 'Объём равен 0'
  FROM pg_temp.psdc_work w
  WHERE w.kind = 'process' AND NOT w.is_deleted AND w.i IS NOT NULL AND round(w.i, 5) = 0;

  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'warning', w.excel_row, x.col || w.excel_row, x.label, 'price_negative', format('%s: отрицательное значение', x.label)
  FROM pg_temp.psdc_work w
  CROSS JOIN LATERAL (VALUES ('J', 'Цена за материал', w.j), ('L', 'Цена за работу', w.l)) x(col, label, val)
  WHERE w.kind = 'process' AND NOT w.is_deleted AND x.val < 0;

  -- Дубли номеров секций делают принадлежность процессов неоднозначной.
  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'error', w.excel_row, 'A' || w.excel_row, '№ п/п', 'section_duplicate',
    format('Номер секции «%s» повторяется (строки %s)', w.num, d.rows_list)
  FROM pg_temp.psdc_work w
  JOIN (
    SELECT num, string_agg(excel_row::text, ', ' ORDER BY excel_row) AS rows_list
    FROM pg_temp.psdc_work
    WHERE kind = 'section' AND NOT is_deleted AND num IS NOT NULL
    GROUP BY num HAVING count(*) > 1
  ) d ON d.num = w.num
  WHERE w.kind = 'section' AND NOT w.is_deleted;

  -- Принадлежность строки секции — по текстовому префиксу «№ секции + точка»:
  -- самая вложенная активная секция, чей номер совпадает с одним из префиксов.
  -- Числового сравнения нет: «5.10» относится к «5», а не к «5.1».
  UPDATE pg_temp.psdc_work w SET parent_id = x.section_id
  FROM (
    SELECT DISTINCT ON (c.row_id) c.row_id AS child_id, s.row_id AS section_id
    FROM pg_temp.psdc_work c
    CROSS JOIN LATERAL unnest(c.prefixes) WITH ORDINALITY u(prefix, depth)
    JOIN pg_temp.psdc_work s ON s.kind = 'section' AND NOT s.is_deleted AND s.num = u.prefix
    WHERE c.kind IS NOT NULL
    ORDER BY c.row_id, u.depth DESC, s.row_order
  ) x
  WHERE w.row_id = x.child_id;

  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'error', w.excel_row, 'A' || w.excel_row, '№ п/п', 'section_not_found',
    format('Не найдена секция для процесса № %s', w.num)
  FROM pg_temp.psdc_work w
  WHERE w.kind = 'process' AND NOT w.is_deleted AND w.num IS NOT NULL AND w.parent_id IS NULL;

  -- Секции: агрегат по всем не deleted процессам, чей номер начинается с № секции + «.».
  --   K = ROUND(SUM(K без ДМ), 2);  M = ROUND(SUM(M), 2) — работы ДМ входят;  O = ROUND(K + M, 2)
  UPDATE pg_temp.psdc_work s SET k = a.sk, m = a.sm, o = round(a.sk + a.sm, 2)
  FROM (
    SELECT sec.row_id,
      round(COALESCE(sum(c.k) FILTER (WHERE NOT c.is_dm), 0), 2) AS sk,
      round(COALESCE(sum(c.m), 0), 2) AS sm
    FROM pg_temp.psdc_work sec
    LEFT JOIN (
      SELECT u.prefix, c.k, c.m, c.is_dm
      FROM pg_temp.psdc_work c
      CROSS JOIN LATERAL unnest(c.prefixes) u(prefix)
      WHERE c.kind = 'process' AND NOT c.is_deleted AND c.k IS NOT NULL
    ) c ON c.prefix = sec.num
    WHERE sec.kind = 'section' AND NOT sec.is_deleted AND sec.num IS NOT NULL
    GROUP BY sec.row_id
  ) a
  WHERE s.row_id = a.row_id;

  -- Итог — только из процессов.
  SELECT
    round(COALESCE(sum(k) FILTER (WHERE NOT is_dm), 0), 2),
    round(COALESCE(sum(m), 0), 2),
    COALESCE(sum(o), 0),
    round(COALESCE(sum(k) FILTER (WHERE is_dm), 0), 2)
  INTO v_tm, v_tw, v_sum_o, v_dm
  FROM pg_temp.psdc_work
  WHERE kind = 'process' AND NOT is_deleted AND k IS NOT NULL;

  v_t := round(v_tm + v_tw, 2);
  IF v_t <> round(v_sum_o, 2) THEN
    RAISE EXCEPTION 'Внутренняя ошибка расчёта ПСДЦ: Материалы + Работы = %, сумма общих стоимостей = %', v_t, v_sum_o;
  END IF;

  SELECT count(*) FILTER (WHERE kind = 'section' AND NOT is_deleted),
         count(*) FILTER (WHERE kind = 'process' AND NOT is_deleted),
         count(*) FILTER (WHERE is_deleted),
         count(*) FILTER (WHERE t_ref IS NULL)
  INTO v_sections, v_processes, v_deleted, v_missing_t
  FROM pg_temp.psdc_work;

  IF v_processes = 0 THEN
    INSERT INTO psdc_issues (psdc_id, severity, code, message)
    VALUES (p.id, 'error', 'no_processes', 'В ведомости нет ни одного комплексного процесса');
  END IF;

  -- ID строки в системе (T): сохраняется, только если однозначно совпал с
  -- постоянным ID строки предыдущей ПСДЦ той же ветки. Иначе строка получает
  -- новый ID (её row_id) — чужую строку T изменить не может.
  v_prev := CASE WHEN p.document_id IS NOT NULL THEN psdc_find_previous(p.document_id) END;

  IF v_prev IS NOT NULL THEN
    UPDATE pg_temp.psdc_work w SET logical_id = w.t_ref
    FROM (
      SELECT t_ref FROM pg_temp.psdc_work WHERE t_ref IS NOT NULL GROUP BY t_ref HAVING count(*) = 1
    ) u
    WHERE w.t_ref = u.t_ref
      AND EXISTS (SELECT 1 FROM psdc_rows pr WHERE pr.psdc_id = v_prev AND pr.logical_line_id = w.t_ref);
  END IF;

  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'warning', q.excel_row, 'T' || q.excel_row, 'ID строки в системе', q.code, q.msg
  FROM (
    SELECT w.excel_row, w.row_order,
      CASE WHEN d.cnt > 1 THEN 't_duplicate' ELSE 't_unknown' END AS code,
      CASE WHEN d.cnt > 1
        THEN format('ID строки «%s» повторяется в файле — строке назначен новый ID', left(w.t_ref, 60))
        ELSE format('ID строки «%s» не найден в предыдущей ПСДЦ ветки — строке назначен новый ID', left(w.t_ref, 60))
      END AS msg,
      row_number() OVER (ORDER BY w.row_order) AS rn
    FROM pg_temp.psdc_work w
    JOIN (SELECT t_ref, count(*) AS cnt FROM pg_temp.psdc_work WHERE t_ref IS NOT NULL GROUP BY t_ref) d ON d.t_ref = w.t_ref
    WHERE w.logical_id IS NULL
  ) q
  WHERE q.rn <= cap;

  SELECT count(*) INTO v_cnt FROM pg_temp.psdc_work WHERE t_ref IS NOT NULL AND logical_id IS NULL;
  IF v_cnt > cap THEN
    INSERT INTO psdc_issues (psdc_id, severity, code, message)
    VALUES (p.id, 'warning', 't_unknown_more', format('И ещё %s строк с неизвестным или повторяющимся ID строки', v_cnt - cap));
  END IF;

  IF v_missing_t > 0 THEN
    INSERT INTO psdc_issues (psdc_id, severity, code, message)
    VALUES (p.id, 'warning', 't_missing',
      format('ID строки в системе (T) не заполнен в %s строк — при применении им будут назначены новые постоянные ID', v_missing_t));
  END IF;

  -- Сохранённые значения старого файла — только для сравнения, не для расчёта.
  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'warning', q.excel_row, q.col || q.excel_row, q.label, 'legacy_value',
    format('%s: в файле %s, расчёт системы %s', q.label, round(q.cached, 2)::text, q.calc::text)
  FROM (
    SELECT w.excel_row, x.col, x.label, x.cached, x.calc,
           row_number() OVER (ORDER BY w.row_order, x.col) AS rn
    FROM pg_temp.psdc_work w
    CROSS JOIN LATERAL (VALUES
      ('K', 'Стоимость за материал', w.ck, w.k), ('M', 'Стоимость за работу', w.cm, w.m),
      ('N', 'Единичная расценка', w.cn, w.n), ('O', 'Общая стоимость', w.co, w.o)) x(col, label, cached, calc)
    WHERE NOT w.is_deleted AND w.kind IS NOT NULL
      AND x.calc IS NOT NULL AND x.cached IS NOT NULL AND round(x.cached, 2) <> x.calc
  ) q
  WHERE q.rn <= cap;

  SELECT count(*) INTO v_cnt
  FROM pg_temp.psdc_work w
  CROSS JOIN LATERAL (VALUES (w.ck, w.k), (w.cm, w.m), (w.cn, w.n), (w.co, w.o)) x(cached, calc)
  WHERE NOT w.is_deleted AND w.kind IS NOT NULL
    AND x.calc IS NOT NULL AND x.cached IS NOT NULL AND round(x.cached, 2) <> x.calc;
  IF v_cnt > cap THEN
    INSERT INTO psdc_issues (psdc_id, severity, code, message)
    VALUES (p.id, 'warning', 'legacy_value_more', format('И ещё %s расхождений сохранённых значений файла с расчётом системы', v_cnt - cap));
  END IF;

  SELECT tk.val AS k, tm.val AS m, tt.val AS o, COALESCE(p.source_meta -> 'totals' ->> 'row', '') AS row_no
  INTO v_legacy
  FROM psdc_parse_decimal(p.source_meta -> 'totals' -> 'k') tk,
       psdc_parse_decimal(p.source_meta -> 'totals' -> 'm') tm,
       psdc_parse_decimal(p.source_meta -> 'totals' -> 'o') tt;

  IF v_legacy.o IS NOT NULL AND round(v_legacy.o, 2) <> v_t THEN
    INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
    VALUES (p.id, 'warning', NULLIF(v_legacy.row_no, '')::int, CASE WHEN v_legacy.row_no <> '' THEN 'O' || v_legacy.row_no END,
      'Итого', 'legacy_total',
      format('Итог в файле %s отличается от расчёта системы %s', round(v_legacy.o, 2)::text, v_t::text));
  END IF;
  IF v_legacy.k IS NOT NULL AND round(v_legacy.k, 2) <> v_tm THEN
    INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
    VALUES (p.id, 'warning', NULLIF(v_legacy.row_no, '')::int, CASE WHEN v_legacy.row_no <> '' THEN 'K' || v_legacy.row_no END,
      'Итого материалы', 'legacy_total',
      format('Материалы в итоге файла %s, расчёт системы %s', round(v_legacy.k, 2)::text, v_tm::text));
  END IF;
  IF v_legacy.m IS NOT NULL AND round(v_legacy.m, 2) <> v_tw THEN
    INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
    VALUES (p.id, 'warning', NULLIF(v_legacy.row_no, '')::int, CASE WHEN v_legacy.row_no <> '' THEN 'M' || v_legacy.row_no END,
      'Итого работы', 'legacy_total',
      format('Работы в итоге файла %s, расчёт системы %s (в старых формулах ДМ мог исключаться и из работ)', round(v_legacy.m, 2)::text, v_tw::text));
  END IF;

  -- НДС — только из документа. Подпись в файле — диагностика.
  IF p.document_id IS NOT NULL THEN
    SELECT rate, includes INTO v_rate, v_incl FROM psdc_document_vat(p.document_id);
    v_vat := CASE
      WHEN v_rate IS NULL OR v_rate = 0 OR v_incl = false THEN 0
      ELSE round(v_t * v_rate / (100 + v_rate), 2)
    END;
  ELSE
    v_rate := NULL;
    v_incl := NULL;
    v_vat := NULL;
  END IF;

  v_file_rate := NULL;
  IF COALESCE(p.source_meta -> 'totals' ->> 'vat_text', '') ~ '[0-9]' THEN
    BEGIN
      v_file_rate := replace((regexp_match(p.source_meta -> 'totals' ->> 'vat_text', '([0-9]+([.,][0-9]+)?)\s*%'))[1], ',', '.')::numeric;
    EXCEPTION WHEN others THEN
      v_file_rate := NULL;
    END;
  END IF;
  IF p.document_id IS NOT NULL AND v_file_rate IS NOT NULL
     AND v_file_rate IS DISTINCT FROM (CASE WHEN v_incl = false THEN NULL ELSE v_rate END) THEN
    INSERT INTO psdc_issues (psdc_id, severity, excel_row, code, message)
    VALUES (p.id, 'warning', NULLIF(p.source_meta -> 'totals' ->> 'vat_row', '')::int, 'vat_rate_mismatch',
      format('В файле указан НДС %s%%, у документа %s — расчёт выполнен по ставке документа', v_file_rate::text,
        CASE WHEN v_rate IS NULL OR v_rate = 0 OR v_incl = false THEN 'без НДС' ELSE v_rate::text || '%' END));
  END IF;

  INSERT INTO psdc_rows (
    id, psdc_id, logical_line_id, source_line_id, row_order, excel_row, row_kind,
    number, resource_type, code, customer_material, is_customer_material, cost_item, name, unit,
    consumption_norm, volume, material_price, material_cost, work_price, work_cost, unit_price, total_cost,
    manufacturer, materials, work_location, comment, parent_section_id, legacy_deleted)
  SELECT
    w.row_id, p.id, COALESCE(w.logical_id, w.row_id::text), w.t_ref, w.row_order, w.excel_row, w.kind,
    w.num, w.rtype, w.code, w.dm_text, w.kind = 'process' AND w.is_dm, w.cost_item, w.name, w.unit,
    CASE WHEN w.kind = 'process' THEN round(w.h, 2) END,
    CASE WHEN w.kind = 'process' THEN round(w.i, 5) END,
    CASE WHEN w.kind = 'process' THEN round(w.j, 2) END,
    w.k,
    CASE WHEN w.kind = 'process' THEN round(w.l, 2) END,
    w.m, w.n, w.o,
    w.manufacturer, w.materials, w.work_location, w.comment,
    w.parent_id,
    w.is_deleted
  FROM pg_temp.psdc_work w;

  SELECT count(*) FILTER (WHERE severity = 'error'), count(*) FILTER (WHERE severity = 'warning')
  INTO v_errors, v_warnings
  FROM psdc_issues WHERE psdc_id = p.id;

  UPDATE psdc SET
    state = CASE WHEN v_errors > 0 THEN 'invalid' ELSE 'validated' END,
    validated_at = now(),
    previous_psdc_id = v_prev,
    error_count = v_errors,
    warning_count = v_warnings,
    section_count = v_sections,
    process_count = v_processes,
    legacy_deleted_count = v_deleted,
    total_material = v_tm,
    total_work = v_tw,
    total = v_t,
    dm_material_excluded = v_dm,
    vat_rate_snapshot = v_rate,
    vat_included_snapshot = v_incl,
    vat_amount = v_vat,
    file_vat_rate = v_file_rate,
    legacy_total = round(v_legacy.o, 2)
  WHERE id = p.id;
END;
$$;


ALTER FUNCTION public.psdc_validate_internal(p_psdc_id uuid) OWNER TO postgres;

--
-- Name: psdc_visible(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.psdc_visible(p_psdc_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM psdc p
    WHERE p.id = p_psdc_id
      AND CASE
            WHEN p.document_id IS NULL THEN p.uploaded_by = auth.uid() OR psdc_contracts_permission(true)
            ELSE psdc_can_view_document(p.document_id)
          END
  );
$$;


ALTER FUNCTION public.psdc_visible(p_psdc_id uuid) OWNER TO postgres;

--
-- Name: refresh_rates_registry(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.refresh_rates_registry() RETURNS timestamp with time zone
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  finished_at timestamptz;
begin
  refresh materialized view concurrently kp_rates_registry_mv;
  refresh materialized view concurrently supply_rates_registry_mv;
  finished_at := now();

  -- Отметка времени, чтобы на странице было видно, насколько свежие данные.
  insert into app_settings (key, value, updated_at)
  values ('rates_registry_refreshed_at', finished_at::text, finished_at)
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at;

  return finished_at;
end;
$$;


ALTER FUNCTION public.refresh_rates_registry() OWNER TO postgres;

--
-- Name: FUNCTION refresh_rates_registry(); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.refresh_rates_registry() IS 'Пересчитывает материализованные представления реестра расценок и пишет отметку времени в app_settings';


--
-- Name: report_client_error(text, text, text, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.report_client_error(p_build_id text, p_section text, p_code text, p_status integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF auth.uid() IS NULL
     OR p_build_id IS NULL OR length(p_build_id) > 40
     OR p_section IS NULL OR length(p_section) > 100
     OR p_code IS NULL OR length(p_code) > 40 THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM public.client_errors
      WHERE user_id = auth.uid() AND at > now() - interval '10 minutes') >= 100 THEN
    RETURN;
  END IF;
  INSERT INTO public.client_errors (user_id, build_id, section, code, status)
  VALUES (auth.uid(), p_build_id, p_section, p_code, p_status);
  IF random() < 0.01 THEN
    DELETE FROM public.client_errors WHERE at < now() - interval '30 days';
  END IF;
END
$$;


ALTER FUNCTION public.report_client_error(p_build_id text, p_section text, p_code text, p_status integer) OWNER TO postgres;

--
-- Name: report_client_version(text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.report_client_version(p_build_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF auth.uid() IS NULL OR p_build_id IS NULL OR length(p_build_id) > 40 THEN
    RETURN;
  END IF;
  INSERT INTO public.client_versions (user_id, build_id, last_seen_at)
  VALUES (auth.uid(), p_build_id, now())
  ON CONFLICT (user_id) DO UPDATE
    SET build_id = EXCLUDED.build_id, last_seen_at = EXCLUDED.last_seen_at;
END
$$;


ALTER FUNCTION public.report_client_version(p_build_id text) OWNER TO postgres;

--
-- Name: sync_tenders_department_from_object(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.sync_tenders_department_from_object() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE tenders
    SET department = CASE NEW.status
                       WHEN 'warranty_service' THEN 'warranty'
                       ELSE 'construction'
                     END
    WHERE object_id = NEW.id
      AND department IN ('construction', 'warranty');
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.sync_tenders_department_from_object() OWNER TO postgres;

--
-- Name: touch_last_login(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.touch_last_login() RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.user_roles set last_login_at = now() where user_id = auth.uid();
$$;


ALTER FUNCTION public.touch_last_login() OWNER TO postgres;

--
-- Name: update_bsm_approved_rates_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_bsm_approved_rates_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_bsm_approved_rates_updated_at() OWNER TO postgres;

--
-- Name: update_bsm_contract_rates_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_bsm_contract_rates_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_bsm_contract_rates_updated_at() OWNER TO postgres;

--
-- Name: update_bsm_contractor_rates_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_bsm_contractor_rates_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_bsm_contractor_rates_updated_at() OWNER TO postgres;

--
-- Name: update_bsm_supply_rates_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_bsm_supply_rates_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_bsm_supply_rates_updated_at() OWNER TO postgres;

--
-- Name: update_clause_disputes_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_clause_disputes_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;


ALTER FUNCTION public.update_clause_disputes_updated_at() OWNER TO postgres;

--
-- Name: update_contacts_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_contacts_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_contacts_updated_at() OWNER TO postgres;

--
-- Name: update_contract_advance_schedule_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_contract_advance_schedule_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_contract_advance_schedule_updated_at() OWNER TO postgres;

--
-- Name: update_contract_clauses_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_contract_clauses_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;


ALTER FUNCTION public.update_contract_clauses_updated_at() OWNER TO postgres;

--
-- Name: update_contract_psdc_items_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_contract_psdc_items_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_contract_psdc_items_updated_at() OWNER TO postgres;

--
-- Name: update_contracts_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_contracts_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_contracts_updated_at() OWNER TO postgres;

--
-- Name: update_counterparties_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_counterparties_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $$;


ALTER FUNCTION public.update_counterparties_updated_at() OWNER TO postgres;

--
-- Name: update_counterparty_contacts_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_counterparty_contacts_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $$;


ALTER FUNCTION public.update_counterparty_contacts_updated_at() OWNER TO postgres;

--
-- Name: update_doc_check_requests_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_doc_check_requests_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;


ALTER FUNCTION public.update_doc_check_requests_updated_at() OWNER TO postgres;

--
-- Name: update_employees_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_employees_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_employees_updated_at() OWNER TO postgres;

--
-- Name: update_object_cost_plan_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_object_cost_plan_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_object_cost_plan_updated_at() OWNER TO postgres;

--
-- Name: update_object_documents_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_object_documents_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_object_documents_updated_at() OWNER TO postgres;

--
-- Name: update_object_estimate_items_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_object_estimate_items_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_object_estimate_items_updated_at() OWNER TO postgres;

--
-- Name: update_objects_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_objects_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_objects_updated_at() OWNER TO postgres;

--
-- Name: update_tasks_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_tasks_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;


ALTER FUNCTION public.update_tasks_updated_at() OWNER TO postgres;

--
-- Name: update_tender_counterparty_proposals_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_tender_counterparty_proposals_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_tender_counterparty_proposals_updated_at() OWNER TO postgres;

--
-- Name: update_tender_estimate_items_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_tender_estimate_items_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_tender_estimate_items_updated_at() OWNER TO postgres;

--
-- Name: update_tender_vor_supply_rates_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_tender_vor_supply_rates_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_tender_vor_supply_rates_updated_at() OWNER TO postgres;

--
-- Name: update_tenders_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_tenders_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_tenders_updated_at() OWNER TO postgres;

--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $$;


ALTER FUNCTION public.update_updated_at_column() OWNER TO postgres;

--
-- Name: vor_requests_can_access(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.vor_requests_can_access() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.is_approved = true AND ur.role <> 'contractor'
  )
  OR EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = auth.uid() AND lower(u.email) = 'sadovnikov.d.y@su10.ru'
  );
$$;


ALTER FUNCTION public.vor_requests_can_access() OWNER TO postgres;

--
-- Name: vor_requests_touch_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.vor_requests_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.vor_requests_touch_updated_at() OWNER TO postgres;

--
-- Name: audit_log_entries; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.audit_log_entries (
    instance_id uuid,
    id uuid NOT NULL,
    payload json,
    created_at timestamp with time zone,
    ip_address character varying(64) DEFAULT ''::character varying NOT NULL
);


ALTER TABLE auth.audit_log_entries OWNER TO supabase_auth_admin;

--
-- Name: TABLE audit_log_entries; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.audit_log_entries IS 'Auth: Audit trail for user actions.';


--
-- Name: custom_oauth_providers; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.custom_oauth_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_type text NOT NULL,
    identifier text NOT NULL,
    name text NOT NULL,
    client_id text NOT NULL,
    client_secret text NOT NULL,
    acceptable_client_ids text[] DEFAULT '{}'::text[] NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    pkce_enabled boolean DEFAULT true NOT NULL,
    attribute_mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    authorization_params jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    email_optional boolean DEFAULT false NOT NULL,
    issuer text,
    discovery_url text,
    skip_nonce_check boolean DEFAULT false NOT NULL,
    cached_discovery jsonb,
    discovery_cached_at timestamp with time zone,
    authorization_url text,
    token_url text,
    userinfo_url text,
    jwks_uri text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    custom_claims_allowlist text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT custom_oauth_providers_authorization_url_https CHECK (((authorization_url IS NULL) OR (authorization_url ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_authorization_url_length CHECK (((authorization_url IS NULL) OR (char_length(authorization_url) <= 2048))),
    CONSTRAINT custom_oauth_providers_client_id_length CHECK (((char_length(client_id) >= 1) AND (char_length(client_id) <= 512))),
    CONSTRAINT custom_oauth_providers_discovery_url_length CHECK (((discovery_url IS NULL) OR (char_length(discovery_url) <= 2048))),
    CONSTRAINT custom_oauth_providers_identifier_format CHECK ((identifier ~ '^[a-z0-9][a-z0-9:-]{0,48}[a-z0-9]$'::text)),
    CONSTRAINT custom_oauth_providers_issuer_length CHECK (((issuer IS NULL) OR ((char_length(issuer) >= 1) AND (char_length(issuer) <= 2048)))),
    CONSTRAINT custom_oauth_providers_jwks_uri_https CHECK (((jwks_uri IS NULL) OR (jwks_uri ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_jwks_uri_length CHECK (((jwks_uri IS NULL) OR (char_length(jwks_uri) <= 2048))),
    CONSTRAINT custom_oauth_providers_name_length CHECK (((char_length(name) >= 1) AND (char_length(name) <= 100))),
    CONSTRAINT custom_oauth_providers_oauth2_requires_endpoints CHECK (((provider_type <> 'oauth2'::text) OR ((authorization_url IS NOT NULL) AND (token_url IS NOT NULL) AND (userinfo_url IS NOT NULL)))),
    CONSTRAINT custom_oauth_providers_oidc_discovery_url_https CHECK (((provider_type <> 'oidc'::text) OR (discovery_url IS NULL) OR (discovery_url ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_oidc_issuer_https CHECK (((provider_type <> 'oidc'::text) OR (issuer IS NULL) OR (issuer ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_oidc_requires_issuer CHECK (((provider_type <> 'oidc'::text) OR (issuer IS NOT NULL))),
    CONSTRAINT custom_oauth_providers_provider_type_check CHECK ((provider_type = ANY (ARRAY['oauth2'::text, 'oidc'::text]))),
    CONSTRAINT custom_oauth_providers_token_url_https CHECK (((token_url IS NULL) OR (token_url ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_token_url_length CHECK (((token_url IS NULL) OR (char_length(token_url) <= 2048))),
    CONSTRAINT custom_oauth_providers_userinfo_url_https CHECK (((userinfo_url IS NULL) OR (userinfo_url ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_userinfo_url_length CHECK (((userinfo_url IS NULL) OR (char_length(userinfo_url) <= 2048)))
);


ALTER TABLE auth.custom_oauth_providers OWNER TO supabase_auth_admin;

--
-- Name: flow_state; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.flow_state (
    id uuid NOT NULL,
    user_id uuid,
    auth_code text,
    code_challenge_method auth.code_challenge_method,
    code_challenge text,
    provider_type text NOT NULL,
    provider_access_token text,
    provider_refresh_token text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    authentication_method text NOT NULL,
    auth_code_issued_at timestamp with time zone,
    invite_token text,
    referrer text,
    oauth_client_state_id uuid,
    linking_target_id uuid,
    email_optional boolean DEFAULT false NOT NULL
);


ALTER TABLE auth.flow_state OWNER TO supabase_auth_admin;

--
-- Name: TABLE flow_state; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.flow_state IS 'Stores metadata for all OAuth/SSO login flows';


--
-- Name: identities; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.identities (
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    identity_data jsonb NOT NULL,
    provider text NOT NULL,
    last_sign_in_at timestamp with time zone,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    email text GENERATED ALWAYS AS (lower((identity_data ->> 'email'::text))) STORED,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


ALTER TABLE auth.identities OWNER TO supabase_auth_admin;

--
-- Name: TABLE identities; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.identities IS 'Auth: Stores identities associated to a user.';


--
-- Name: COLUMN identities.email; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON COLUMN auth.identities.email IS 'Auth: Email is a generated column that references the optional email property in the identity_data';


--
-- Name: instances; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.instances (
    id uuid NOT NULL,
    uuid uuid,
    raw_base_config text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


ALTER TABLE auth.instances OWNER TO supabase_auth_admin;

--
-- Name: TABLE instances; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.instances IS 'Auth: Manages users across multiple sites.';


--
-- Name: mfa_amr_claims; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.mfa_amr_claims (
    session_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    authentication_method text NOT NULL,
    id uuid NOT NULL
);


ALTER TABLE auth.mfa_amr_claims OWNER TO supabase_auth_admin;

--
-- Name: TABLE mfa_amr_claims; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.mfa_amr_claims IS 'auth: stores authenticator method reference claims for multi factor authentication';


--
-- Name: mfa_challenges; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.mfa_challenges (
    id uuid NOT NULL,
    factor_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    verified_at timestamp with time zone,
    ip_address inet NOT NULL,
    otp_code text,
    web_authn_session_data jsonb
);


ALTER TABLE auth.mfa_challenges OWNER TO supabase_auth_admin;

--
-- Name: TABLE mfa_challenges; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.mfa_challenges IS 'auth: stores metadata about challenge requests made';


--
-- Name: mfa_factors; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.mfa_factors (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    friendly_name text,
    factor_type auth.factor_type NOT NULL,
    status auth.factor_status NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    secret text,
    phone text,
    last_challenged_at timestamp with time zone,
    web_authn_credential jsonb,
    web_authn_aaguid uuid,
    last_webauthn_challenge_data jsonb
);


ALTER TABLE auth.mfa_factors OWNER TO supabase_auth_admin;

--
-- Name: TABLE mfa_factors; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.mfa_factors IS 'auth: stores metadata about factors';


--
-- Name: COLUMN mfa_factors.last_webauthn_challenge_data; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON COLUMN auth.mfa_factors.last_webauthn_challenge_data IS 'Stores the latest WebAuthn challenge data including attestation/assertion for customer verification';


--
-- Name: mfa_recovery_code_sets; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.mfa_recovery_code_sets (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    mfa_factor_id uuid NOT NULL,
    failed_verification_count integer DEFAULT 0 NOT NULL,
    verification_locked_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mfa_recovery_code_sets_failed_verification_count_check CHECK ((failed_verification_count >= 0))
);


ALTER TABLE auth.mfa_recovery_code_sets OWNER TO supabase_auth_admin;

--
-- Name: mfa_recovery_codes; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.mfa_recovery_codes (
    id uuid NOT NULL,
    mfa_recovery_code_set_id uuid NOT NULL,
    code_hash text NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE auth.mfa_recovery_codes OWNER TO supabase_auth_admin;

--
-- Name: oauth_authorizations; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.oauth_authorizations (
    id uuid NOT NULL,
    authorization_id text NOT NULL,
    client_id uuid NOT NULL,
    user_id uuid,
    redirect_uri text NOT NULL,
    scope text NOT NULL,
    state text,
    resource text,
    code_challenge text,
    code_challenge_method auth.code_challenge_method,
    response_type auth.oauth_response_type DEFAULT 'code'::auth.oauth_response_type NOT NULL,
    status auth.oauth_authorization_status DEFAULT 'pending'::auth.oauth_authorization_status NOT NULL,
    authorization_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:03:00'::interval) NOT NULL,
    approved_at timestamp with time zone,
    nonce text,
    CONSTRAINT oauth_authorizations_authorization_code_length CHECK ((char_length(authorization_code) <= 255)),
    CONSTRAINT oauth_authorizations_code_challenge_length CHECK ((char_length(code_challenge) <= 128)),
    CONSTRAINT oauth_authorizations_expires_at_future CHECK ((expires_at > created_at)),
    CONSTRAINT oauth_authorizations_nonce_length CHECK ((char_length(nonce) <= 255)),
    CONSTRAINT oauth_authorizations_redirect_uri_length CHECK ((char_length(redirect_uri) <= 2048)),
    CONSTRAINT oauth_authorizations_resource_length CHECK ((char_length(resource) <= 2048)),
    CONSTRAINT oauth_authorizations_scope_length CHECK ((char_length(scope) <= 4096)),
    CONSTRAINT oauth_authorizations_state_length CHECK ((char_length(state) <= 4096))
);


ALTER TABLE auth.oauth_authorizations OWNER TO supabase_auth_admin;

--
-- Name: oauth_client_states; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.oauth_client_states (
    id uuid NOT NULL,
    provider_type text NOT NULL,
    code_verifier text,
    created_at timestamp with time zone NOT NULL
);


ALTER TABLE auth.oauth_client_states OWNER TO supabase_auth_admin;

--
-- Name: TABLE oauth_client_states; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.oauth_client_states IS 'Stores OAuth states for third-party provider authentication flows where Supabase acts as the OAuth client.';


--
-- Name: oauth_clients; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.oauth_clients (
    id uuid NOT NULL,
    client_secret_hash text,
    registration_type auth.oauth_registration_type NOT NULL,
    redirect_uris text NOT NULL,
    grant_types text NOT NULL,
    client_name text,
    client_uri text,
    logo_uri text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    client_type auth.oauth_client_type DEFAULT 'confidential'::auth.oauth_client_type NOT NULL,
    token_endpoint_auth_method text NOT NULL,
    CONSTRAINT oauth_clients_client_name_length CHECK ((char_length(client_name) <= 1024)),
    CONSTRAINT oauth_clients_client_uri_length CHECK ((char_length(client_uri) <= 2048)),
    CONSTRAINT oauth_clients_logo_uri_length CHECK ((char_length(logo_uri) <= 2048)),
    CONSTRAINT oauth_clients_token_endpoint_auth_method_check CHECK ((token_endpoint_auth_method = ANY (ARRAY['client_secret_basic'::text, 'client_secret_post'::text, 'none'::text])))
);


ALTER TABLE auth.oauth_clients OWNER TO supabase_auth_admin;

--
-- Name: oauth_consents; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.oauth_consents (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    scopes text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT oauth_consents_revoked_after_granted CHECK (((revoked_at IS NULL) OR (revoked_at >= granted_at))),
    CONSTRAINT oauth_consents_scopes_length CHECK ((char_length(scopes) <= 2048)),
    CONSTRAINT oauth_consents_scopes_not_empty CHECK ((char_length(TRIM(BOTH FROM scopes)) > 0))
);


ALTER TABLE auth.oauth_consents OWNER TO supabase_auth_admin;

--
-- Name: one_time_tokens; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.one_time_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_type auth.one_time_token_type NOT NULL,
    token_hash text NOT NULL,
    relates_to text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT one_time_tokens_token_hash_check CHECK ((char_length(token_hash) > 0))
);


ALTER TABLE auth.one_time_tokens OWNER TO supabase_auth_admin;

--
-- Name: refresh_tokens; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.refresh_tokens (
    instance_id uuid,
    id bigint NOT NULL,
    token character varying(255),
    user_id character varying(255),
    revoked boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    parent character varying(255),
    session_id uuid
);


ALTER TABLE auth.refresh_tokens OWNER TO supabase_auth_admin;

--
-- Name: TABLE refresh_tokens; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.refresh_tokens IS 'Auth: Store of tokens used to refresh JWT tokens once they expire.';


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE; Schema: auth; Owner: supabase_auth_admin
--

CREATE SEQUENCE auth.refresh_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE auth.refresh_tokens_id_seq OWNER TO supabase_auth_admin;

--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: auth; Owner: supabase_auth_admin
--

ALTER SEQUENCE auth.refresh_tokens_id_seq OWNED BY auth.refresh_tokens.id;


--
-- Name: saml_providers; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.saml_providers (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    entity_id text NOT NULL,
    metadata_xml text NOT NULL,
    metadata_url text,
    attribute_mapping jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    name_id_format text,
    CONSTRAINT "entity_id not empty" CHECK ((char_length(entity_id) > 0)),
    CONSTRAINT "metadata_url not empty" CHECK (((metadata_url = NULL::text) OR (char_length(metadata_url) > 0))),
    CONSTRAINT "metadata_xml not empty" CHECK ((char_length(metadata_xml) > 0))
);


ALTER TABLE auth.saml_providers OWNER TO supabase_auth_admin;

--
-- Name: TABLE saml_providers; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.saml_providers IS 'Auth: Manages SAML Identity Provider connections.';


--
-- Name: saml_relay_states; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.saml_relay_states (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    request_id text NOT NULL,
    for_email text,
    redirect_to text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    flow_state_id uuid,
    CONSTRAINT "request_id not empty" CHECK ((char_length(request_id) > 0))
);


ALTER TABLE auth.saml_relay_states OWNER TO supabase_auth_admin;

--
-- Name: TABLE saml_relay_states; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.saml_relay_states IS 'Auth: Contains SAML Relay State information for each Service Provider initiated login.';


--
-- Name: schema_migrations; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.schema_migrations (
    version character varying(255) NOT NULL
);


ALTER TABLE auth.schema_migrations OWNER TO supabase_auth_admin;

--
-- Name: TABLE schema_migrations; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.schema_migrations IS 'Auth: Manages updates to the auth system.';


--
-- Name: scim_tokens; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.scim_tokens (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    token_hash text NOT NULL,
    prefix text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    CONSTRAINT scim_tokens_expires_at_future CHECK (((expires_at IS NULL) OR (expires_at > created_at))),
    CONSTRAINT scim_tokens_revoked_after_created CHECK (((revoked_at IS NULL) OR (revoked_at >= created_at))),
    CONSTRAINT scim_tokens_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE auth.scim_tokens OWNER TO supabase_auth_admin;

--
-- Name: scim_users; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.scim_users (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    user_id uuid,
    resource jsonb NOT NULL,
    user_name text GENERATED ALWAYS AS (lower((resource ->> 'userName'::text))) STORED NOT NULL,
    external_id text GENERATED ALWAYS AS ((resource ->> 'externalId'::text)) STORED,
    active boolean GENERATED ALWAYS AS (COALESCE(((resource ->> 'active'::text))::boolean, true)) STORED NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


ALTER TABLE auth.scim_users OWNER TO supabase_auth_admin;

--
-- Name: sessions; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    factor_id uuid,
    aal auth.aal_level,
    not_after timestamp with time zone,
    refreshed_at timestamp without time zone,
    user_agent text,
    ip inet,
    tag text,
    oauth_client_id uuid,
    refresh_token_hmac_key text,
    refresh_token_counter bigint,
    scopes text,
    CONSTRAINT sessions_scopes_length CHECK ((char_length(scopes) <= 4096))
);


ALTER TABLE auth.sessions OWNER TO supabase_auth_admin;

--
-- Name: TABLE sessions; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.sessions IS 'Auth: Stores session data associated to a user.';


--
-- Name: COLUMN sessions.not_after; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON COLUMN auth.sessions.not_after IS 'Auth: Not after is a nullable column that contains a timestamp after which the session should be regarded as expired.';


--
-- Name: COLUMN sessions.refresh_token_hmac_key; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON COLUMN auth.sessions.refresh_token_hmac_key IS 'Holds a HMAC-SHA256 key used to sign refresh tokens for this session.';


--
-- Name: COLUMN sessions.refresh_token_counter; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON COLUMN auth.sessions.refresh_token_counter IS 'Holds the ID (counter) of the last issued refresh token.';


--
-- Name: sso_domains; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.sso_domains (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    domain text NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    CONSTRAINT "domain not empty" CHECK ((char_length(domain) > 0))
);


ALTER TABLE auth.sso_domains OWNER TO supabase_auth_admin;

--
-- Name: TABLE sso_domains; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.sso_domains IS 'Auth: Manages SSO email address domain mapping to an SSO Identity Provider.';


--
-- Name: sso_providers; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.sso_providers (
    id uuid NOT NULL,
    resource_id text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    disabled boolean,
    CONSTRAINT "resource_id not empty" CHECK (((resource_id = NULL::text) OR (char_length(resource_id) > 0)))
);


ALTER TABLE auth.sso_providers OWNER TO supabase_auth_admin;

--
-- Name: TABLE sso_providers; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.sso_providers IS 'Auth: Manages SSO identity provider information; see saml_providers for SAML.';


--
-- Name: COLUMN sso_providers.resource_id; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON COLUMN auth.sso_providers.resource_id IS 'Auth: Uniquely identifies a SSO provider according to a user-chosen resource ID (case insensitive), useful in infrastructure as code.';


--
-- Name: users; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.users (
    instance_id uuid,
    id uuid NOT NULL,
    aud character varying(255),
    role character varying(255),
    email character varying(255),
    encrypted_password character varying(255),
    email_confirmed_at timestamp with time zone,
    invited_at timestamp with time zone,
    confirmation_token character varying(255),
    confirmation_sent_at timestamp with time zone,
    recovery_token character varying(255),
    recovery_sent_at timestamp with time zone,
    email_change_token_new character varying(255),
    email_change character varying(255),
    email_change_sent_at timestamp with time zone,
    last_sign_in_at timestamp with time zone,
    raw_app_meta_data jsonb,
    raw_user_meta_data jsonb,
    is_super_admin boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    phone text DEFAULT NULL::character varying,
    phone_confirmed_at timestamp with time zone,
    phone_change text DEFAULT ''::character varying,
    phone_change_token character varying(255) DEFAULT ''::character varying,
    phone_change_sent_at timestamp with time zone,
    confirmed_at timestamp with time zone GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
    email_change_token_current character varying(255) DEFAULT ''::character varying,
    email_change_confirm_status smallint DEFAULT 0,
    banned_until timestamp with time zone,
    reauthentication_token character varying(255) DEFAULT ''::character varying,
    reauthentication_sent_at timestamp with time zone,
    is_sso_user boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    is_anonymous boolean DEFAULT false NOT NULL,
    CONSTRAINT users_email_change_confirm_status_check CHECK (((email_change_confirm_status >= 0) AND (email_change_confirm_status <= 2)))
);


ALTER TABLE auth.users OWNER TO supabase_auth_admin;

--
-- Name: TABLE users; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON TABLE auth.users IS 'Auth: Stores user login data within a secure schema.';


--
-- Name: COLUMN users.is_sso_user; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON COLUMN auth.users.is_sso_user IS 'Auth: Set this column to true when the account comes from SSO. These accounts can have duplicate emails.';


--
-- Name: webauthn_challenges; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.webauthn_challenges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    challenge_type text NOT NULL,
    session_data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT webauthn_challenges_challenge_type_check CHECK ((challenge_type = ANY (ARRAY['signup'::text, 'registration'::text, 'authentication'::text])))
);


ALTER TABLE auth.webauthn_challenges OWNER TO supabase_auth_admin;

--
-- Name: webauthn_credentials; Type: TABLE; Schema: auth; Owner: supabase_auth_admin
--

CREATE TABLE auth.webauthn_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    credential_id bytea NOT NULL,
    public_key bytea NOT NULL,
    attestation_type text DEFAULT ''::text NOT NULL,
    aaguid uuid,
    sign_count bigint DEFAULT 0 NOT NULL,
    transports jsonb DEFAULT '[]'::jsonb NOT NULL,
    backup_eligible boolean DEFAULT false NOT NULL,
    backed_up boolean DEFAULT false NOT NULL,
    friendly_name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);


ALTER TABLE auth.webauthn_credentials OWNER TO supabase_auth_admin;

--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.app_settings (
    key text NOT NULL,
    value text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.app_settings OWNER TO postgres;

--
-- Name: TABLE app_settings; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.app_settings IS 'Глобальные настройки приложения (key/value), task 324';


--
-- Name: bsm_contract_rates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.bsm_contract_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid,
    material_name text NOT NULL,
    unit text,
    contract_price numeric(15,2) NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.bsm_contract_rates OWNER TO postgres;

--
-- Name: TABLE bsm_contract_rates; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.bsm_contract_rates IS 'Согласованные расценки на материалы для договоров (фиксированные цены)';


--
-- Name: COLUMN bsm_contract_rates.object_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_contract_rates.object_id IS 'Ссылка на объект';


--
-- Name: COLUMN bsm_contract_rates.material_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_contract_rates.material_name IS 'Наименование материала';


--
-- Name: COLUMN bsm_contract_rates.unit; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_contract_rates.unit IS 'Единица измерения';


--
-- Name: COLUMN bsm_contract_rates.contract_price; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_contract_rates.contract_price IS 'Согласованная цена для договора';


--
-- Name: COLUMN bsm_contract_rates.notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_contract_rates.notes IS 'Примечания';


--
-- Name: bsm_contractor_rates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.bsm_contractor_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid,
    counterparty_id uuid,
    material_name text NOT NULL,
    unit text,
    contractor_price numeric(15,2) NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.bsm_contractor_rates OWNER TO postgres;

--
-- Name: TABLE bsm_contractor_rates; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.bsm_contractor_rates IS 'Расценки БСМ с подрядчиком (привязка к объекту и подрядчику)';


--
-- Name: COLUMN bsm_contractor_rates.object_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_contractor_rates.object_id IS 'Ссылка на объект';


--
-- Name: COLUMN bsm_contractor_rates.counterparty_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_contractor_rates.counterparty_id IS 'Ссылка на подрядчика';


--
-- Name: COLUMN bsm_contractor_rates.material_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_contractor_rates.material_name IS 'Наименование материала';


--
-- Name: COLUMN bsm_contractor_rates.unit; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_contractor_rates.unit IS 'Единица измерения';


--
-- Name: COLUMN bsm_contractor_rates.contractor_price; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_contractor_rates.contractor_price IS 'Цена от подрядчика';


--
-- Name: COLUMN bsm_contractor_rates.notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_contractor_rates.notes IS 'Примечания';


--
-- Name: bsm_supply_rates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.bsm_supply_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid,
    material_name text NOT NULL,
    unit text,
    supply_price numeric(15,2) NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    applied_at date
);


ALTER TABLE public.bsm_supply_rates OWNER TO postgres;

--
-- Name: TABLE bsm_supply_rates; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.bsm_supply_rates IS 'Актуальные расценки от снабжения на материалы по объектам';


--
-- Name: COLUMN bsm_supply_rates.object_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_supply_rates.object_id IS 'Ссылка на объект';


--
-- Name: COLUMN bsm_supply_rates.material_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_supply_rates.material_name IS 'Наименование материала';


--
-- Name: COLUMN bsm_supply_rates.unit; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_supply_rates.unit IS 'Единица измерения';


--
-- Name: COLUMN bsm_supply_rates.supply_price; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_supply_rates.supply_price IS 'Актуальная цена от снабжения';


--
-- Name: COLUMN bsm_supply_rates.notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_supply_rates.notes IS 'Примечания';


--
-- Name: COLUMN bsm_supply_rates.applied_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bsm_supply_rates.applied_at IS 'Дата применения расценки (когда расценка была использована)';


--
-- Name: client_errors; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.client_errors (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid,
    build_id text NOT NULL,
    section text NOT NULL,
    code text NOT NULL,
    status integer
);


ALTER TABLE public.client_errors OWNER TO postgres;

--
-- Name: TABLE client_errors; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.client_errors IS 'Коды отказов сервера по разделам, без персональных данных (телеметрия релизов)';


--
-- Name: client_errors_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.client_errors_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.client_errors_id_seq OWNER TO postgres;

--
-- Name: client_errors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.client_errors_id_seq OWNED BY public.client_errors.id;


--
-- Name: client_versions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.client_versions (
    user_id uuid NOT NULL,
    build_id text NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.client_versions OWNER TO postgres;

--
-- Name: TABLE client_versions; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.client_versions IS 'Какая сборка фронта открыта у пользователя (телеметрия релизов)';


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    full_name character varying(255) NOT NULL,
    "position" character varying(100) NOT NULL,
    phone character varying(50),
    email character varying(255),
    object_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    office character varying(100),
    department_id uuid,
    notes text
);


ALTER TABLE public.contacts OWNER TO postgres;

--
-- Name: TABLE contacts; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.contacts IS 'Контакты (руководители, экономисты, инженеры)';


--
-- Name: COLUMN contacts.id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contacts.id IS 'Уникальный идентификатор контакта';


--
-- Name: COLUMN contacts.full_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contacts.full_name IS 'ФИО контакта';


--
-- Name: COLUMN contacts."position"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contacts."position" IS 'Должность';


--
-- Name: COLUMN contacts.phone; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contacts.phone IS 'Телефон';


--
-- Name: COLUMN contacts.email; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contacts.email IS 'Email';


--
-- Name: COLUMN contacts.object_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contacts.object_id IS 'Ссылка на объект строительства';


--
-- Name: COLUMN contacts.created_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contacts.created_at IS 'Дата и время создания записи';


--
-- Name: COLUMN contacts.updated_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contacts.updated_at IS 'Дата и время последнего обновления записи';


--
-- Name: COLUMN contacts.department_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contacts.department_id IS 'Отдел сотрудника (FK на departments)';


--
-- Name: COLUMN contacts.notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contacts.notes IS 'Произвольное примечание к сотруднику';


--
-- Name: contract_advance_schedule; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contract_advance_schedule (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    planned_date date,
    amount numeric(15,2),
    description text,
    paid_date date,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.contract_advance_schedule OWNER TO postgres;

--
-- Name: TABLE contract_advance_schedule; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.contract_advance_schedule IS 'График авансирования договора: в определённые даты — определённые суммы';


--
-- Name: contract_appendices; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contract_appendices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    appendix_number text,
    name text,
    responsible text,
    status text,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    notes text,
    parent_id uuid,
    number_manual boolean DEFAULT false,
    approved_object boolean DEFAULT false,
    approved_counterparty boolean DEFAULT false
);


ALTER TABLE public.contract_appendices OWNER TO postgres;

--
-- Name: COLUMN contract_appendices.notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_appendices.notes IS 'Примечание юриста по статусу приложения';


--
-- Name: COLUMN contract_appendices.parent_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_appendices.parent_id IS 'Родительское приложение (для подпунктов №N.1); NULL — верхний уровень';


--
-- Name: COLUMN contract_appendices.number_manual; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_appendices.number_manual IS 'true — номер (appendix_number) задан вручную, иначе считается автоматически';


--
-- Name: COLUMN contract_appendices.approved_object; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_appendices.approved_object IS 'Приложение согласовано с объектом';


--
-- Name: COLUMN contract_appendices.approved_counterparty; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_appendices.approved_counterparty IS 'Приложение согласовано с контрагентом';


--
-- Name: contract_attachments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contract_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    attachment_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    comment text
);


ALTER TABLE public.contract_attachments OWNER TO postgres;

--
-- Name: COLUMN contract_attachments.comment; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_attachments.comment IS 'Комментарий к приложению в рамках конкретного договора';


--
-- Name: contract_audit_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contract_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    event_type text NOT NULL,
    field_name text,
    old_value jsonb,
    new_value jsonb,
    description text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by_role text,
    changed_by_name text
);


ALTER TABLE public.contract_audit_log OWNER TO postgres;

--
-- Name: TABLE contract_audit_log; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.contract_audit_log IS 'Аудит-лог изменений договоров (создание, смена статуса, удаление, изменения полей)';


--
-- Name: COLUMN contract_audit_log.event_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_audit_log.event_type IS 'Тип события: created | status_changed | soft_deleted | restored | deleted | field_updated';


--
-- Name: COLUMN contract_audit_log.field_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_audit_log.field_name IS 'Имя поля для event_type=field_updated';


--
-- Name: COLUMN contract_audit_log.old_value; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_audit_log.old_value IS 'Прежнее значение (JSONB)';


--
-- Name: COLUMN contract_audit_log.new_value; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_audit_log.new_value IS 'Новое значение (JSONB)';


--
-- Name: COLUMN contract_audit_log.description; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_audit_log.description IS 'Человекочитаемое описание для отображения в UI';


--
-- Name: COLUMN contract_audit_log.changed_by_role; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_audit_log.changed_by_role IS 'Роль пользователя из localStorage(userRole)';


--
-- Name: COLUMN contract_audit_log.changed_by_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_audit_log.changed_by_name IS 'ФИО пользователя из user_roles, если доступно';


--
-- Name: contract_clause_comments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contract_clause_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dispute_id uuid NOT NULL,
    counterparty_id uuid NOT NULL,
    author_side text NOT NULL,
    author_name text,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT contract_clause_comments_author_side_check CHECK ((author_side = ANY (ARRAY['employee'::text, 'contractor'::text])))
);

ALTER TABLE ONLY public.contract_clause_comments REPLICA IDENTITY FULL;


ALTER TABLE public.contract_clause_comments OWNER TO postgres;

--
-- Name: contract_clause_dispute_clauses; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contract_clause_dispute_clauses (
    dispute_id uuid NOT NULL,
    clause_id uuid NOT NULL
);


ALTER TABLE public.contract_clause_dispute_clauses OWNER TO postgres;

--
-- Name: contract_clause_disputes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contract_clause_disputes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    counterparty_id uuid NOT NULL,
    label text,
    our_text text DEFAULT ''::text NOT NULL,
    counterparty_text text DEFAULT ''::text NOT NULL,
    final_text text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_by_side text DEFAULT 'contractor'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT contract_clause_disputes_created_by_side_check CHECK ((created_by_side = ANY (ARRAY['employee'::text, 'contractor'::text]))),
    CONSTRAINT contract_clause_disputes_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_review'::text, 'agreed'::text, 'rejected'::text])))
);

ALTER TABLE ONLY public.contract_clause_disputes REPLICA IDENTITY FULL;


ALTER TABLE public.contract_clause_disputes OWNER TO postgres;

--
-- Name: contract_clauses; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contract_clauses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    clause_number text,
    body text DEFAULT ''::text NOT NULL,
    order_index integer DEFAULT 0 NOT NULL,
    level integer DEFAULT 1 NOT NULL,
    is_heading boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.contract_clauses REPLICA IDENTITY FULL;


ALTER TABLE public.contract_clauses OWNER TO postgres;

--
-- Name: contract_counterparties; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contract_counterparties (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    counterparty_id uuid NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.contract_counterparties OWNER TO postgres;

--
-- Name: TABLE contract_counterparties; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.contract_counterparties IS 'Стороны договора (может быть несколько). sort_order = 0 — основной контрагент (дублируется в contracts.counterparty_id)';


--
-- Name: contract_psdc_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.contract_psdc_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    agreement_id uuid,
    change_type character varying(10),
    target_item_id uuid,
    row_number integer,
    code character varying(50),
    cost_name text,
    unit character varying(50),
    quantity numeric(15,4),
    unit_price_materials numeric(15,2) DEFAULT 0,
    unit_price_works numeric(15,2) DEFAULT 0,
    unit_price numeric(15,2) DEFAULT 0,
    total_price numeric(15,2) DEFAULT 0,
    vat_percent numeric(5,2) DEFAULT 0,
    is_davalchesky boolean DEFAULT false,
    is_section boolean DEFAULT false,
    original_row_number character varying(20),
    notes text,
    import_mode character varying(20) DEFAULT 'separate'::character varying,
    is_approved boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.contract_psdc_items OWNER TO postgres;

--
-- Name: TABLE contract_psdc_items; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.contract_psdc_items IS 'ПСДЦ договора — строки сметы договорной цены (контроль объёмов и сумм)';


--
-- Name: COLUMN contract_psdc_items.agreement_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_psdc_items.agreement_id IS 'Резерв под ДС: строка относится к ДС (NULL = базовая ПСДЦ договора)';


--
-- Name: COLUMN contract_psdc_items.change_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_psdc_items.change_type IS 'Резерв под ДС: тип изменения строки add/modify/remove';


--
-- Name: COLUMN contract_psdc_items.is_davalchesky; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.contract_psdc_items.is_davalchesky IS 'Давальческий материал: объём отображается, в сумму договора не входит';


--
-- Name: contracts_display_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.contracts_display_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.contracts_display_id_seq OWNER TO postgres;

--
-- Name: contracts_display_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.contracts_display_id_seq OWNED BY public.contracts.display_id;


--
-- Name: counterparties; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.counterparties (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    inn text,
    kpp text,
    legal_address text,
    actual_address text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    website text,
    work_type text,
    status public.counterparty_status DEFAULT 'active'::public.counterparty_status,
    notes text,
    department text,
    deleted_at timestamp with time zone
);


ALTER TABLE public.counterparties OWNER TO postgres;

--
-- Name: TABLE counterparties; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.counterparties IS 'Справочник контрагентов (подрядчиков)';


--
-- Name: COLUMN counterparties.id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparties.id IS 'Уникальный идентификатор контрагента';


--
-- Name: COLUMN counterparties.name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparties.name IS 'Наименование организации';


--
-- Name: COLUMN counterparties.inn; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparties.inn IS 'ИНН (Идентификационный номер налогоплательщика)';


--
-- Name: COLUMN counterparties.kpp; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparties.kpp IS 'КПП (Код причины постановки на учет)';


--
-- Name: COLUMN counterparties.legal_address; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparties.legal_address IS 'Юридический адрес';


--
-- Name: COLUMN counterparties.actual_address; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparties.actual_address IS 'Фактический адрес';


--
-- Name: COLUMN counterparties.created_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparties.created_at IS 'Дата и время создания записи';


--
-- Name: COLUMN counterparties.updated_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparties.updated_at IS 'Дата и время последнего обновления записи';


--
-- Name: COLUMN counterparties.website; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparties.website IS 'Ссылка на сайт контрагента';


--
-- Name: COLUMN counterparties.work_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparties.work_type IS 'Вид работ контрагента';


--
-- Name: COLUMN counterparties.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparties.status IS 'Статус контрагента (действующий/черный список)';


--
-- Name: COLUMN counterparties.notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparties.notes IS 'Примечания к контрагенту';


--
-- Name: COLUMN counterparties.deleted_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparties.deleted_at IS 'Время мягкого удаления; NULL = активный контрагент';


--
-- Name: counterparties_inn_backup_2026_09_21; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.counterparties_inn_backup_2026_09_21 (
    id uuid,
    name text,
    inn text,
    updated_at timestamp with time zone,
    backup_at timestamp with time zone
);


ALTER TABLE public.counterparties_inn_backup_2026_09_21 OWNER TO postgres;

--
-- Name: counterparty_audit_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.counterparty_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    counterparty_id uuid NOT NULL,
    event_type text NOT NULL,
    field_name text,
    old_value jsonb,
    new_value jsonb,
    description text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by_role text,
    changed_by_name text
);


ALTER TABLE public.counterparty_audit_log OWNER TO postgres;

--
-- Name: TABLE counterparty_audit_log; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.counterparty_audit_log IS 'История изменений контрагента: поля карточки, статус, примечания, контактные лица';


--
-- Name: counterparty_contacts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.counterparty_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    counterparty_id uuid,
    full_name text NOT NULL,
    "position" text,
    phone text,
    email text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.counterparty_contacts OWNER TO postgres;

--
-- Name: TABLE counterparty_contacts; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.counterparty_contacts IS 'Контактные лица контрагентов';


--
-- Name: COLUMN counterparty_contacts.id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparty_contacts.id IS 'Уникальный идентификатор контакта';


--
-- Name: COLUMN counterparty_contacts.counterparty_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparty_contacts.counterparty_id IS 'Ссылка на контрагента';


--
-- Name: COLUMN counterparty_contacts.full_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparty_contacts.full_name IS 'ФИО контактного лица';


--
-- Name: COLUMN counterparty_contacts."position"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparty_contacts."position" IS 'Должность';


--
-- Name: COLUMN counterparty_contacts.phone; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparty_contacts.phone IS 'Номер телефона';


--
-- Name: COLUMN counterparty_contacts.email; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparty_contacts.email IS 'Email';


--
-- Name: COLUMN counterparty_contacts.created_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparty_contacts.created_at IS 'Дата и время создания записи';


--
-- Name: COLUMN counterparty_contacts.updated_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.counterparty_contacts.updated_at IS 'Дата и время последнего обновления записи';


--
-- Name: counterparty_relations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.counterparty_relations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    counterparty_id uuid NOT NULL,
    related_counterparty_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT no_self_relation CHECK ((counterparty_id <> related_counterparty_id))
);


ALTER TABLE public.counterparty_relations OWNER TO postgres;

--
-- Name: dc_request_audit_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.dc_request_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dc_request_id uuid NOT NULL,
    event_type text NOT NULL,
    field_name text,
    old_value jsonb,
    new_value jsonb,
    description text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by_role text,
    changed_by_name text
);


ALTER TABLE public.dc_request_audit_log OWNER TO postgres;

--
-- Name: TABLE dc_request_audit_log; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.dc_request_audit_log IS 'История изменений заявок на ДС: что изменилось (было→стало), кто и когда';


--
-- Name: COLUMN dc_request_audit_log.changed_by_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_request_audit_log.changed_by_name IS 'Снимок ФИО автора на момент изменения (переименование сотрудника историю не меняет)';


--
-- Name: dc_request_tasks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.dc_request_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    task_text text NOT NULL,
    response_text text,
    order_number integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    is_completed boolean DEFAULT false NOT NULL,
    created_by_name text,
    responded_by_name text,
    responded_at timestamp with time zone
);


ALTER TABLE public.dc_request_tasks OWNER TO postgres;

--
-- Name: TABLE dc_request_tasks; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.dc_request_tasks IS 'Задачи (с ответами) в рамках одной заявки на ДС';


--
-- Name: COLUMN dc_request_tasks.task_text; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_request_tasks.task_text IS 'Текст задачи в рамках рассмотрения заявки';


--
-- Name: COLUMN dc_request_tasks.response_text; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_request_tasks.response_text IS 'Ответ по задаче';


--
-- Name: COLUMN dc_request_tasks.order_number; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_request_tasks.order_number IS 'Порядок отображения задачи внутри заявки';


--
-- Name: COLUMN dc_request_tasks.is_completed; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_request_tasks.is_completed IS 'Задача отмечена выполненной (checkbox в UI)';


--
-- Name: COLUMN dc_request_tasks.created_by_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_request_tasks.created_by_name IS 'Snapshot ФИО автора задачи (task 337)';


--
-- Name: COLUMN dc_request_tasks.responded_by_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_request_tasks.responded_by_name IS 'Snapshot ФИО автора ответа (task 337)';


--
-- Name: COLUMN dc_request_tasks.responded_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_request_tasks.responded_at IS 'Момент первого сохранения ответа (task 337)';


--
-- Name: dc_requests; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.dc_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    counterparty_id uuid,
    ds_number character varying(100),
    works_description text,
    responsible_contact_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    status text DEFAULT 'contract_check'::text NOT NULL,
    created_by_name text,
    expected_approval_date date,
    amount_before numeric(14,2),
    amount_after numeric(14,2),
    material_type text,
    deleted_at timestamp with time zone,
    check_status text DEFAULT 'not_checked'::text NOT NULL,
    ds_type text,
    folder_path text,
    check_result_notes text,
    checked_by_name text,
    checked_at timestamp with time zone,
    CONSTRAINT dc_requests_check_status_check CHECK ((check_status = ANY (ARRAY['not_checked'::text, 'matches'::text, 'matches_with_remarks'::text, 'not_matches'::text]))),
    CONSTRAINT dc_requests_ds_type_check CHECK (((ds_type IS NULL) OR (ds_type = ANY (ARRAY['psdc_change'::text, 'extra_in_contract'::text, 'extra_out_contract'::text, 'tender_ds'::text])))),
    CONSTRAINT dc_requests_material_type_check CHECK ((material_type = ANY (ARRAY['tolling'::text, 'realization'::text]))),
    CONSTRAINT dc_requests_status_check CHECK ((status = ANY (ARRAY['contract_check'::text, 'check_result'::text, 'in_work'::text, 'completed'::text])))
);


ALTER TABLE public.dc_requests OWNER TO postgres;

--
-- Name: TABLE dc_requests; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.dc_requests IS 'Реестр заявок на дополнительные соглашения (task 306)';


--
-- Name: COLUMN dc_requests.ds_number; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_requests.ds_number IS 'Свободный текстовый номер ДС (не связан с object_documents)';


--
-- Name: COLUMN dc_requests.works_description; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_requests.works_description IS 'Выполняемые работы по заявке';


--
-- Name: COLUMN dc_requests.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_requests.status IS 'Этап заявки: contract_check (проверка по договору) → check_result (итог проверки) → in_work (в работе) → completed (завершено)';


--
-- Name: COLUMN dc_requests.created_by_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_requests.created_by_name IS 'ФИО сотрудника, создавшего заявку (снапшот на момент INSERT)';


--
-- Name: COLUMN dc_requests.expected_approval_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_requests.expected_approval_date IS 'Ориентировочный срок согласования заявки на ДС. Заполняется после создания.';


--
-- Name: COLUMN dc_requests.check_status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_requests.check_status IS 'Исход проверки по договору: not_checked | matches (соответствует) | matches_with_remarks (соответствует с замечаниями) | not_matches (не соответствует)';


--
-- Name: COLUMN dc_requests.ds_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_requests.ds_type IS 'Тип ДС: psdc_change (изменение ПСДЦ) | extra_in_contract (доп. работы по текущему договору) | extra_out_contract (доп. работы вне договора) | tender_ds (ДС по тендеру)';


--
-- Name: COLUMN dc_requests.folder_path; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_requests.folder_path IS 'Путь к папке с документами в файловом хранилище (UNC или локальный). Показывается для копирования: браузер не может открыть проводник по клику';


--
-- Name: COLUMN dc_requests.check_result_notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_requests.check_result_notes IS 'Заключение юриста по итогам сверки с договором: что проверено, какие расхождения найдены';


--
-- Name: COLUMN dc_requests.checked_by_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_requests.checked_by_name IS 'Кто зафиксировал результат проверки (ФИО на момент фиксации)';


--
-- Name: COLUMN dc_requests.checked_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dc_requests.checked_at IS 'Когда зафиксирован результат проверки';


--
-- Name: departments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.departments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.departments OWNER TO postgres;

--
-- Name: TABLE departments; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.departments IS 'Справочник отделов компании';


--
-- Name: doc_check_request_audit_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.doc_check_request_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    event_type text NOT NULL,
    field_name text,
    old_value jsonb,
    new_value jsonb,
    description text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by_role text,
    changed_by_name text
);


ALTER TABLE public.doc_check_request_audit_log OWNER TO postgres;

--
-- Name: doc_check_requests; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.doc_check_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid,
    counterparty_id uuid,
    doc_type text NOT NULL,
    doc_number text,
    doc_date date,
    status text DEFAULT 'new'::text NOT NULL,
    notes text,
    sort_order integer DEFAULT 0 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_name text,
    CONSTRAINT doc_check_requests_doc_type_check CHECK ((doc_type = ANY (ARRAY['dp'::text, 'ds'::text]))),
    CONSTRAINT doc_check_requests_status_check CHECK ((status = ANY (ARRAY['new'::text, 'in_progress'::text, 'edo'::text, 'signal'::text, 'accounting'::text, 'done'::text, 'awaiting_scan'::text])))
);


ALTER TABLE public.doc_check_requests OWNER TO postgres;

--
-- Name: TABLE doc_check_requests; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.doc_check_requests IS 'Заявки на проверку ДП/ДС — канбан вместо переписки по почте';


--
-- Name: COLUMN doc_check_requests.doc_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.doc_check_requests.doc_type IS 'dp — договор подряда, ds — дополнительное соглашение';


--
-- Name: COLUMN doc_check_requests.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.doc_check_requests.status IS 'new | in_progress | edo (выгрузка по ЭДО) | signal (загрузка в Signal) | accounting (занесение в 1С) | done | awaiting_scan (ждём подписанный бумажный оригинал)';


--
-- Name: COLUMN doc_check_requests.sort_order; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.doc_check_requests.sort_order IS 'Порядок карточки внутри колонки канбана';


--
-- Name: document_check_requests; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.document_check_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid,
    counterparty_id uuid,
    doc_type text NOT NULL,
    doc_number text NOT NULL,
    doc_date date NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    responsible_contact_id uuid,
    CONSTRAINT document_check_requests_doc_type_check CHECK ((doc_type = ANY (ARRAY['ДП'::text, 'ДС'::text]))),
    CONSTRAINT document_check_requests_status_check CHECK ((status = ANY (ARRAY['new'::text, 'in_progress'::text, 'edo_export'::text, '1c_entry'::text, 'completed'::text])))
);


ALTER TABLE public.document_check_requests OWNER TO postgres;

--
-- Name: TABLE document_check_requests; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.document_check_requests IS 'Заявки на проверку договоров подряда и дополнительных соглашений (канбан)';


--
-- Name: COLUMN document_check_requests.doc_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.document_check_requests.doc_type IS 'Тип документа: ДП (договор подряда) или ДС (дополнительное соглашение)';


--
-- Name: COLUMN document_check_requests.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.document_check_requests.status IS 'Колонка канбана: new | in_progress | edo_export | 1c_entry | completed';


--
-- Name: COLUMN document_check_requests.responsible_contact_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.document_check_requests.responsible_contact_id IS 'Ответственный сотрудник за проверку (FK на contacts)';


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'engineer'::text NOT NULL,
    is_approved boolean DEFAULT false NOT NULL,
    email text,
    created_at timestamp with time zone DEFAULT now(),
    full_name text,
    work_phone text,
    work_email text,
    object_id uuid,
    last_login_at timestamp with time zone,
    object_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    counterparty_id uuid,
    requested_company text,
    is_blocked boolean DEFAULT false NOT NULL,
    blocked_at timestamp with time zone,
    blocked_by_name text,
    CONSTRAINT user_roles_blocked_not_approved CHECK ((NOT (is_blocked AND is_approved)))
);


ALTER TABLE public.user_roles OWNER TO postgres;

--
-- Name: COLUMN user_roles.object_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_roles.object_id IS 'Объект, к которому прикреплён пользователь. NULL = офис (видит все объекты)';


--
-- Name: COLUMN user_roles.last_login_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_roles.last_login_at IS 'Время последнего успешного входа (обновляется приложением при signInWithPassword)';


--
-- Name: COLUMN user_roles.object_ids; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_roles.object_ids IS 'Объекты, к которым привязан сотрудник. Пустой массив = офис (видит все объекты). Заменяет одиночный object_id.';


--
-- Name: COLUMN user_roles.counterparty_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_roles.counterparty_id IS 'Организация-контрагент, к которой привязан логин (NULL = сотрудник СУ-10). ON DELETE RESTRICT: удаление организации не должно превращать её логины в сотрудников';


--
-- Name: COLUMN user_roles.requested_company; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_roles.requested_company IS 'Организация, указанная подрядчиком при регистрации (название + ИНН, свободный текст). Служит подсказкой администратору для привязки counterparty_id';


--
-- Name: COLUMN user_roles.is_blocked; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_roles.is_blocked IS 'Доступ заблокирован администратором (в отличие от заявки, ожидающей подтверждения). Заблокированный всегда is_approved=false';


--
-- Name: COLUMN user_roles.blocked_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_roles.blocked_at IS 'Когда заблокирован';


--
-- Name: COLUMN user_roles.blocked_by_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_roles.blocked_by_name IS 'Кто заблокировал (ФИО администратора)';


--
-- Name: employee_directory; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.employee_directory WITH (security_barrier='true') AS
 SELECT user_id,
    role,
    COALESCE(NULLIF(full_name, ''::text), email) AS display_name,
    full_name,
    email
   FROM public.user_roles ur
  WHERE ((is_approved = true) AND (counterparty_id IS NULL) AND (role <> 'contractor'::text) AND public.is_negotiation_employee());


ALTER VIEW public.employee_directory OWNER TO postgres;

--
-- Name: VIEW employee_directory; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.employee_directory IS 'Справочник сотрудников СУ-10 (подтверждённые логины без привязки к контрагенту) для выбора исполнителя задач. Виден только сотрудникам: для логина подрядчика возвращает пустой результат';


--
-- Name: employees; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    full_name character varying(255) NOT NULL,
    "position" character varying(255) NOT NULL,
    phone character varying(50),
    email character varying(255),
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.employees OWNER TO postgres;

--
-- Name: general_document_folders; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.general_document_folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category text DEFAULT 'general'::text NOT NULL,
    parent_id uuid,
    name text NOT NULL,
    sort_order integer,
    created_by uuid,
    created_by_name text,
    updated_by uuid,
    updated_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT general_document_folders_name_not_blank CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT general_document_folders_no_self_parent CHECK (((parent_id IS NULL) OR (parent_id <> id)))
);


ALTER TABLE public.general_document_folders OWNER TO postgres;

--
-- Name: TABLE general_document_folders; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.general_document_folders IS 'Папки раздела «Документы»: произвольная вложенность внутри одной подгруппы';


--
-- Name: COLUMN general_document_folders.parent_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.general_document_folders.parent_id IS 'Родительская папка; NULL = корень подгруппы. ON DELETE RESTRICT — непустую папку удалить нельзя';


--
-- Name: COLUMN general_document_folders.sort_order; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.general_document_folders.sort_order IS 'Порядок среди соседей одного родителя (шаг 10 — запас под вставки без перенумерации)';


--
-- Name: general_document_links; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.general_document_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    general_document_id uuid NOT NULL,
    title text,
    url text NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.general_document_links OWNER TO postgres;

--
-- Name: general_documents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.general_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    source_type text NOT NULL,
    link_url text,
    s3_document_id uuid,
    sort_order integer,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    description text,
    updated_by uuid,
    updated_by_name text,
    category text DEFAULT 'general'::text NOT NULL,
    folder_id uuid,
    CONSTRAINT general_documents_source_type_check CHECK ((source_type = ANY (ARRAY['file'::text, 'link'::text, 'mixed'::text])))
);


ALTER TABLE public.general_documents OWNER TO postgres;

--
-- Name: COLUMN general_documents.category; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.general_documents.category IS 'Подгруппа документа: general (Общая информация) | engineers | economists | lawyers';


--
-- Name: COLUMN general_documents.folder_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.general_documents.folder_id IS 'Папка, в которой лежит карточка; NULL = корень подгруппы. ON DELETE RESTRICT — папку с документами удалить нельзя';


--
-- Name: objects; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    address text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    map_link text,
    latitude numeric(10,8),
    longitude numeric(11,8),
    status public.object_status DEFAULT 'main_construction'::public.object_status,
    planned_start_date date,
    planned_end_date date,
    total_area numeric(12,2),
    budget numeric(15,2),
    cover_image_url text,
    contract_template_link text,
    contract_template_name text,
    email character varying(255),
    developer character varying(255),
    design character varying(255),
    construction_manager_contact_id uuid,
    economist_contact_id uuid
);


ALTER TABLE public.objects OWNER TO postgres;

--
-- Name: TABLE objects; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.objects IS 'Объекты строительства';


--
-- Name: COLUMN objects.id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.id IS 'Уникальный идентификатор объекта';


--
-- Name: COLUMN objects.name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.name IS 'Название объекта';


--
-- Name: COLUMN objects.address; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.address IS 'Адрес объекта';


--
-- Name: COLUMN objects.description; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.description IS 'Описание объекта';


--
-- Name: COLUMN objects.created_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.created_at IS 'Дата и время создания записи';


--
-- Name: COLUMN objects.updated_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.updated_at IS 'Дата и время последнего обновления записи';


--
-- Name: COLUMN objects.map_link; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.map_link IS 'Ссылка на карту (Google Maps, Yandex Maps и т.д.)';


--
-- Name: COLUMN objects.latitude; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.latitude IS 'Широта объекта (latitude) в десятичных градусах';


--
-- Name: COLUMN objects.longitude; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.longitude IS 'Долгота объекта (longitude) в десятичных градусах';


--
-- Name: COLUMN objects.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.status IS 'Статус объекта: основное строительство или гарантийное обслуживание';


--
-- Name: COLUMN objects.planned_start_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.planned_start_date IS 'Планируемая дата начала работ';


--
-- Name: COLUMN objects.planned_end_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.planned_end_date IS 'Планируемая дата окончания работ';


--
-- Name: COLUMN objects.total_area; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.total_area IS 'Общая площадь объекта в м²';


--
-- Name: COLUMN objects.budget; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.budget IS 'Бюджет объекта в рублях';


--
-- Name: COLUMN objects.email; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.email IS 'Контактный email объекта (task 335)';


--
-- Name: COLUMN objects.developer; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.developer IS 'Застройщик объекта';


--
-- Name: COLUMN objects.design; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.design IS 'Проектирование (проектная организация)';


--
-- Name: COLUMN objects.construction_manager_contact_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.construction_manager_contact_id IS 'Руководитель строительства объекта (ссылка на реестр сотрудников contacts)';


--
-- Name: COLUMN objects.economist_contact_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.objects.economist_contact_id IS 'Экономист объекта (ссылка на реестр сотрудников contacts)';


--
-- Name: tender_counterparty_proposals; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tender_counterparty_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tender_id uuid NOT NULL,
    counterparty_id uuid NOT NULL,
    estimate_item_id uuid NOT NULL,
    unit_price_materials numeric(15,2) DEFAULT 0,
    unit_price_works numeric(15,2) DEFAULT 0,
    total_unit_price numeric(15,2) DEFAULT 0,
    total_materials numeric(15,2) DEFAULT 0,
    total_works numeric(15,2) DEFAULT 0,
    total_cost numeric(15,2) DEFAULT 0,
    participant_note text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    proposal_date date
);


ALTER TABLE public.tender_counterparty_proposals OWNER TO postgres;

--
-- Name: TABLE tender_counterparty_proposals; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.tender_counterparty_proposals IS 'Ценовые предложения контрагентов по позициям сметы';


--
-- Name: COLUMN tender_counterparty_proposals.unit_price_materials; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparty_proposals.unit_price_materials IS 'Цена за единицу: материалы/оборудование с НДС';


--
-- Name: COLUMN tender_counterparty_proposals.unit_price_works; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparty_proposals.unit_price_works IS 'Цена за единицу: СМР/ПНР с НДС';


--
-- Name: COLUMN tender_counterparty_proposals.total_unit_price; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparty_proposals.total_unit_price IS 'ИТОГО цена за единицу с НДС';


--
-- Name: COLUMN tender_counterparty_proposals.total_materials; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparty_proposals.total_materials IS 'Стоимость материалы/оборудование';


--
-- Name: COLUMN tender_counterparty_proposals.total_works; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparty_proposals.total_works IS 'Стоимость СМР/ПНР';


--
-- Name: COLUMN tender_counterparty_proposals.total_cost; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparty_proposals.total_cost IS 'ИТОГО стоимость с НДС';


--
-- Name: COLUMN tender_counterparty_proposals.participant_note; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparty_proposals.participant_note IS 'Примечание участника тендера';


--
-- Name: COLUMN tender_counterparty_proposals.proposal_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparty_proposals.proposal_date IS 'Дата предоставления КП контрагентом (task 347). Одна дата на весь файл КП.';


--
-- Name: tender_estimate_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tender_estimate_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tender_id uuid NOT NULL,
    row_number integer NOT NULL,
    code character varying(50),
    cost_type character varying(255),
    cost_name text NOT NULL,
    calculation_note text,
    unit character varying(50),
    work_volume numeric(15,4),
    material_consumption numeric(15,4),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    estimate_name text DEFAULT 'Основная смета'::text,
    is_section boolean DEFAULT false,
    original_row_number text,
    outline_level integer DEFAULT 0 NOT NULL
);


ALTER TABLE public.tender_estimate_items OWNER TO postgres;

--
-- Name: TABLE tender_estimate_items; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.tender_estimate_items IS 'Позиции единой сметы тендера';


--
-- Name: COLUMN tender_estimate_items.row_number; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_estimate_items.row_number IS '№ п/п';


--
-- Name: COLUMN tender_estimate_items.code; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_estimate_items.code IS 'КОД позиции';


--
-- Name: COLUMN tender_estimate_items.cost_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_estimate_items.cost_type IS 'Вид затрат';


--
-- Name: COLUMN tender_estimate_items.cost_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_estimate_items.cost_name IS 'Наименование затрат';


--
-- Name: COLUMN tender_estimate_items.calculation_note; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_estimate_items.calculation_note IS 'Примечание к расчету';


--
-- Name: COLUMN tender_estimate_items.unit; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_estimate_items.unit IS 'Единица измерения';


--
-- Name: COLUMN tender_estimate_items.work_volume; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_estimate_items.work_volume IS 'Объем по виду работ';


--
-- Name: COLUMN tender_estimate_items.material_consumption; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_estimate_items.material_consumption IS 'Общий расход по материалу';


--
-- Name: COLUMN tender_estimate_items.is_section; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_estimate_items.is_section IS 'Признак того, что строка является заголовком раздела (секции)';


--
-- Name: COLUMN tender_estimate_items.original_row_number; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_estimate_items.original_row_number IS 'Оригинальный номер строки из Excel; для разделов может содержать иерархический код-заголовок';


--
-- Name: COLUMN tender_estimate_items.outline_level; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_estimate_items.outline_level IS 'Уровень группировки из Excel (ws.!rows[i].level): 0 — верхний, больше — глубже';


--
-- Name: tenders_public_number_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.tenders_public_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.tenders_public_number_seq OWNER TO postgres;

--
-- Name: tenders; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tenders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid,
    work_description text NOT NULL,
    status character varying(50) DEFAULT 'Заявка на тендер'::character varying NOT NULL,
    start_date date,
    end_date date,
    tender_package_link text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    winner_counterparty_id uuid,
    responsible_employee_id uuid,
    responsible_contact_id uuid,
    notes text,
    cost_plan_link text,
    cost_plan_responsible_id uuid,
    summary_proposal_link text,
    cost_plan_status text DEFAULT 'not_started'::text NOT NULL,
    vor_link text,
    vor_responsible_id uuid,
    vor_status text DEFAULT 'not_started'::text NOT NULL,
    vor_start_date date,
    vor_end_date date,
    tender_start_date date,
    tender_end_date date,
    cost_plan_start_date date,
    cost_plan_end_date date,
    deleted_at timestamp with time zone,
    tender_type text DEFAULT 'main'::text NOT NULL,
    parent_tender_id uuid,
    materials_proposal_deadline date,
    materials_proposal_link text,
    public_tender_number integer DEFAULT nextval('public.tenders_public_number_seq'::regclass),
    cost_plan_notes text,
    materials_status text DEFAULT 'not_started'::text NOT NULL,
    tg_published boolean DEFAULT false NOT NULL,
    tg_published_at timestamp with time zone,
    tg_published_by text,
    department text DEFAULT 'construction'::text NOT NULL,
    custom_object_name text,
    completion_letter_sent boolean DEFAULT false NOT NULL,
    completion_letter_sent_at timestamp with time zone,
    completion_letter_sent_by text,
    folder_path text,
    rd_checked boolean DEFAULT false NOT NULL,
    rd_checked_at timestamp with time zone,
    rd_checked_by text,
    vor_sto_user_id uuid,
    vor_sto_name text,
    materials_priority text,
    materials_resp_user_id uuid,
    materials_resp_name text,
    vor_division text,
    materials_proposal_start_date date,
    CONSTRAINT check_dates CHECK ((end_date >= start_date)),
    CONSTRAINT tenders_materials_priority_check CHECK (((materials_priority IS NULL) OR (materials_priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])))),
    CONSTRAINT tenders_parent_only_for_materials CHECK (((tender_type = 'materials'::text) OR (parent_tender_id IS NULL))),
    CONSTRAINT tenders_tender_type_check CHECK ((tender_type = ANY (ARRAY['main'::text, 'materials'::text]))),
    CONSTRAINT valid_cost_plan_status CHECK ((cost_plan_status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'awaiting_kp'::text, 'completed'::text, 'not_required'::text]))),
    CONSTRAINT valid_materials_status CHECK ((materials_status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'completed'::text, 'not_required'::text]))),
    CONSTRAINT valid_tender_department CHECK ((department = ANY (ARRAY['construction'::text, 'warranty'::text, 'joint'::text, 'other'::text]))),
    CONSTRAINT valid_vor_division CHECK (((vor_division IS NULL) OR (vor_division = ANY (ARRAY['monolith'::text, 'nvf_spk'::text, 'general'::text, 'hvac_water'::text, 'electrical'::text])))),
    CONSTRAINT valid_vor_status CHECK ((vor_status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'completed'::text, 'not_required'::text])))
);

ALTER TABLE ONLY public.tenders REPLICA IDENTITY FULL;


ALTER TABLE public.tenders OWNER TO postgres;

--
-- Name: TABLE tenders; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.tenders IS 'Тендеры и тендерные процедуры';


--
-- Name: COLUMN tenders.id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.id IS 'Уникальный идентификатор тендера';


--
-- Name: COLUMN tenders.object_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.object_id IS 'Ссылка на объект строительства';


--
-- Name: COLUMN tenders.work_description; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.work_description IS 'Описание работ';


--
-- Name: COLUMN tenders.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.status IS 'Статус тендера (Новый, В процессе, Завершён, Отменён)';


--
-- Name: COLUMN tenders.start_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.start_date IS 'Дата начала тендерной процедуры';


--
-- Name: COLUMN tenders.end_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.end_date IS 'Дата окончания тендерной процедуры';


--
-- Name: COLUMN tenders.tender_package_link; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.tender_package_link IS 'Ссылка на тендерный пакет';


--
-- Name: COLUMN tenders.created_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.created_at IS 'Дата и время создания записи';


--
-- Name: COLUMN tenders.updated_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.updated_at IS 'Дата и время последнего обновления записи';


--
-- Name: COLUMN tenders.winner_counterparty_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.winner_counterparty_id IS 'Контрагент-победитель тендера';


--
-- Name: COLUMN tenders.responsible_employee_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.responsible_employee_id IS 'Ответственный сотрудник ОСП за тендер';


--
-- Name: COLUMN tenders.responsible_contact_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.responsible_contact_id IS 'Ответственный сотрудник за тендер (из таблицы contacts)';


--
-- Name: COLUMN tenders.notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.notes IS 'Примечание по тендеру (свободный текст, ведётся ответственным)';


--
-- Name: COLUMN tenders.cost_plan_link; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.cost_plan_link IS 'Ссылка на план затрат (Google/Yandex Drive)';


--
-- Name: COLUMN tenders.cost_plan_responsible_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.cost_plan_responsible_id IS 'Ответственный сотрудник за план затрат (из таблицы contacts)';


--
-- Name: COLUMN tenders.summary_proposal_link; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.summary_proposal_link IS 'Ссылка на сводную таблицу КП (Google/Yandex Drive)';


--
-- Name: COLUMN tenders.cost_plan_status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.cost_plan_status IS 'Статус плана затрат: not_started | in_progress | awaiting_kp | completed | not_required';


--
-- Name: COLUMN tenders.vor_link; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.vor_link IS 'Ссылка на ВОР (Google/Yandex Drive)';


--
-- Name: COLUMN tenders.vor_responsible_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.vor_responsible_id IS 'Ответственный сотрудник за ВОР (из contacts)';


--
-- Name: COLUMN tenders.vor_status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.vor_status IS 'Статус ВОР: not_started | in_progress | completed | not_required (не требуется)';


--
-- Name: COLUMN tenders.vor_start_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.vor_start_date IS 'Дата начала подготовки ВОР (сметный отдел)';


--
-- Name: COLUMN tenders.vor_end_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.vor_end_date IS 'Дата окончания подготовки ВОР';


--
-- Name: COLUMN tenders.tender_start_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.tender_start_date IS 'Дата начала тендерной процедуры (ОСП)';


--
-- Name: COLUMN tenders.tender_end_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.tender_end_date IS 'Дата окончания тендерной процедуры';


--
-- Name: COLUMN tenders.cost_plan_start_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.cost_plan_start_date IS 'Срок выполнения плана затрат: начало';


--
-- Name: COLUMN tenders.cost_plan_end_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.cost_plan_end_date IS 'Срок выполнения плана затрат: окончание';


--
-- Name: COLUMN tenders.deleted_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.deleted_at IS 'Метка мягкого удаления. NULL — активный тендер; если задано — тендер скрыт во всех вкладках, кроме «Удалённые».';


--
-- Name: COLUMN tenders.materials_proposal_deadline; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.materials_proposal_deadline IS 'Срок предоставления КП на материалы (для tender_type = materials)';


--
-- Name: COLUMN tenders.materials_proposal_link; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.materials_proposal_link IS 'Ссылка на КП на материалы (для tender_type = materials)';


--
-- Name: COLUMN tenders.public_tender_number; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.public_tender_number IS 'Сквозной публичный номер тендера, присваивается при создании';


--
-- Name: COLUMN tenders.cost_plan_notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.cost_plan_notes IS 'Примечание по плану затрат (свободный текст на странице «Планы затрат»)';


--
-- Name: COLUMN tenders.materials_status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.materials_status IS 'Статус по материалам основного тендера: not_started | in_progress | completed | not_required';


--
-- Name: COLUMN tenders.tg_published; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.tg_published IS 'Тендер опубликован в Telegram-канале';


--
-- Name: COLUMN tenders.tg_published_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.tg_published_at IS 'Когда отмечена публикация в ТГ';


--
-- Name: COLUMN tenders.tg_published_by; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.tg_published_by IS 'Кто отметил публикацию в ТГ (ФИО/e-mail)';


--
-- Name: COLUMN tenders.department; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.department IS 'Направление: construction (основное строительство) | warranty (гарантийный отдел) | joint (совместные) | other (прочее)';


--
-- Name: COLUMN tenders.custom_object_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.custom_object_name IS 'Наименование объекта, вписанное вручную (направление «прочее»). Используется, когда object_id пуст; в реестр objects не попадает';


--
-- Name: COLUMN tenders.completion_letter_sent; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.completion_letter_sent IS 'Письмо о завершении тендера разослано всем участникам (шаг между подведением итогов и завершением)';


--
-- Name: COLUMN tenders.completion_letter_sent_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.completion_letter_sent_at IS 'Когда отмечена рассылка письма о завершении тендера';


--
-- Name: COLUMN tenders.completion_letter_sent_by; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.completion_letter_sent_by IS 'Кто отметил рассылку письма о завершении тендера (ФИО на момент отметки)';


--
-- Name: COLUMN tenders.folder_path; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.folder_path IS 'Путь к папке с документами тендера в файловом хранилище (UNC или локальный). Показывается для копирования: браузер не может открыть проводник по клику';


--
-- Name: COLUMN tenders.rd_checked; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.rd_checked IS 'РД тендерного пакета проверена';


--
-- Name: COLUMN tenders.rd_checked_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.rd_checked_at IS 'Когда отмечена проверка РД';


--
-- Name: COLUMN tenders.rd_checked_by; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.rd_checked_by IS 'Кто отметил проверку РД (ФИО)';


--
-- Name: COLUMN tenders.vor_sto_user_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.vor_sto_user_id IS 'Ответственный СТО за ВОРы и РД: auth.users.id пользователя с ролью сметно-технического отдела';


--
-- Name: COLUMN tenders.vor_sto_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.vor_sto_name IS 'ФИО ответственного СТО на момент назначения (для показа без чтения user_roles)';


--
-- Name: COLUMN tenders.materials_priority; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.materials_priority IS 'Приоритет тендера на материалы: low | medium | high (NULL — не указан)';


--
-- Name: COLUMN tenders.materials_resp_user_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.materials_resp_user_id IS 'Ответственный за тендер на материалы: auth.users.id пользователя с ролью снабжения';


--
-- Name: COLUMN tenders.materials_resp_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.materials_resp_name IS 'ФИО ответственного снабженца на момент назначения';


--
-- Name: COLUMN tenders.vor_division; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.vor_division IS 'Подразделение ВОР: monolith (Монолит) | nvf_spk (НВФ, СПК) | general (Общестроительные работы) | hvac_water (ОВ, ВК) | electrical (ЭОМ, СС)';


--
-- Name: COLUMN tenders.materials_proposal_start_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tenders.materials_proposal_start_date IS 'Начало срока предоставления КП на материалы (окончание — materials_proposal_deadline)';


--
-- Name: kp_rates_registry_mv; Type: MATERIALIZED VIEW; Schema: public; Owner: postgres
--

CREATE MATERIALIZED VIEW public.kp_rates_registry_mv AS
 WITH entries AS (
         SELECT p.id AS proposal_id,
            'material'::text AS item_type,
            ei.cost_name AS item_name,
            ei.unit,
            p.unit_price_materials AS price,
            p.tender_id,
            p.counterparty_id,
            p.proposal_date,
            t.object_id,
            t.work_description AS tender_desc,
            o.name AS object_name,
            c.name AS counterparty_name
           FROM ((((public.tender_counterparty_proposals p
             JOIN public.tender_estimate_items ei ON ((ei.id = p.estimate_item_id)))
             JOIN public.tenders t ON ((t.id = p.tender_id)))
             LEFT JOIN public.objects o ON ((o.id = t.object_id)))
             LEFT JOIN public.counterparties c ON ((c.id = p.counterparty_id)))
          WHERE ((COALESCE(ei.material_consumption, (0)::numeric) > (0)::numeric) AND (COALESCE(p.unit_price_materials, (0)::numeric) > (0)::numeric) AND (public.kp_norm_name(ei.cost_name) <> ''::text))
        UNION ALL
         SELECT p.id,
            'work'::text,
            ei.cost_name,
            ei.unit,
            p.unit_price_works,
            p.tender_id,
            p.counterparty_id,
            p.proposal_date,
            t.object_id,
            t.work_description,
            o.name,
            c.name
           FROM ((((public.tender_counterparty_proposals p
             JOIN public.tender_estimate_items ei ON ((ei.id = p.estimate_item_id)))
             JOIN public.tenders t ON ((t.id = p.tender_id)))
             LEFT JOIN public.objects o ON ((o.id = t.object_id)))
             LEFT JOIN public.counterparties c ON ((c.id = p.counterparty_id)))
          WHERE ((COALESCE(ei.work_volume, (0)::numeric) > (0)::numeric) AND (COALESCE(p.unit_price_works, (0)::numeric) > (0)::numeric) AND (public.kp_norm_name(ei.cost_name) <> ''::text))
        )
 SELECT DISTINCT ON (tender_id, counterparty_id, item_type, (public.kp_norm_name(item_name)), (public.kp_norm_unit((unit)::text))) md5((((((((((tender_id)::text || '|'::text) || (counterparty_id)::text) || '|'::text) || item_type) || '|'::text) || public.kp_norm_name(item_name)) || '|'::text) || public.kp_norm_unit((unit)::text))) AS id,
    item_type,
    item_name,
    unit,
    price,
    tender_id,
    counterparty_id,
    object_id,
    tender_desc,
    object_name,
    counterparty_name,
    proposal_date
   FROM entries
  ORDER BY tender_id, counterparty_id, item_type, (public.kp_norm_name(item_name)), (public.kp_norm_unit((unit)::text)), proposal_date DESC NULLS LAST
  WITH NO DATA;


ALTER MATERIALIZED VIEW public.kp_rates_registry_mv OWNER TO postgres;

--
-- Name: MATERIALIZED VIEW kp_rates_registry_mv; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON MATERIALIZED VIEW public.kp_rates_registry_mv IS 'Реестр расценок из КП подрядчиков (дедуп по DISTINCT ON). Обновляется refresh_rates_registry()';


--
-- Name: kp_rates_registry; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.kp_rates_registry AS
 SELECT id,
    item_type,
    item_name,
    unit,
    price,
    tender_id,
    counterparty_id,
    object_id,
    tender_desc,
    object_name,
    counterparty_name,
    proposal_date
   FROM public.kp_rates_registry_mv;


ALTER VIEW public.kp_rates_registry OWNER TO postgres;

--
-- Name: kp_rates_registry_filter_counterparties; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.kp_rates_registry_filter_counterparties AS
 SELECT DISTINCT r.counterparty_id,
    c.name AS counterparty_name
   FROM (public.kp_rates_registry_mv r
     JOIN public.counterparties c ON ((c.id = r.counterparty_id)))
  WHERE (r.counterparty_id IS NOT NULL);


ALTER VIEW public.kp_rates_registry_filter_counterparties OWNER TO postgres;

--
-- Name: kp_rates_registry_filter_objects; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.kp_rates_registry_filter_objects AS
 SELECT DISTINCT r.object_id,
    o.name AS object_name
   FROM (public.kp_rates_registry_mv r
     JOIN public.objects o ON ((o.id = r.object_id)))
  WHERE (r.object_id IS NOT NULL);


ALTER VIEW public.kp_rates_registry_filter_objects OWNER TO postgres;

--
-- Name: kp_rates_registry_filter_tenders; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.kp_rates_registry_filter_tenders AS
 SELECT DISTINCT tender_id,
    tender_desc,
    object_id
   FROM public.kp_rates_registry_mv r
  WHERE ((tender_id IS NOT NULL) AND (COALESCE(tender_desc, ''::text) <> ''::text));


ALTER VIEW public.kp_rates_registry_filter_tenders OWNER TO postgres;

--
-- Name: kp_rates_registry_units; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.kp_rates_registry_units AS
 SELECT DISTINCT unit
   FROM public.kp_rates_registry_mv
  WHERE ((unit IS NOT NULL) AND ((unit)::text <> ''::text));


ALTER VIEW public.kp_rates_registry_units OWNER TO postgres;

--
-- Name: object_areas; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.object_areas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    parent_area_id uuid,
    area_type text NOT NULL,
    value numeric(14,2),
    unit text DEFAULT 'м²'::text,
    data_source text,
    calc_method text,
    notes text,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.object_areas OWNER TO postgres;

--
-- Name: object_contract_attachments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.object_contract_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    name text NOT NULL,
    link text,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    description text,
    parent_id uuid,
    number_label text,
    number_manual boolean DEFAULT false
);


ALTER TABLE public.object_contract_attachments OWNER TO postgres;

--
-- Name: COLUMN object_contract_attachments.description; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_contract_attachments.description IS 'Краткая сводка о приложении (показывается в строке списка)';


--
-- Name: COLUMN object_contract_attachments.parent_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_contract_attachments.parent_id IS 'Родительское приложение (для подпунктов №N.1); NULL — верхний уровень';


--
-- Name: COLUMN object_contract_attachments.number_label; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_contract_attachments.number_label IS 'Ручной override номера приложения; при NULL номер считается автоматически';


--
-- Name: COLUMN object_contract_attachments.number_manual; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_contract_attachments.number_manual IS 'true — номер (number_label) задан вручную, иначе авто';


--
-- Name: object_cost_plan; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.object_cost_plan (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    category character varying(255) NOT NULL,
    estimated_amount numeric(15,2) DEFAULT 0,
    actual_amount numeric(15,2) DEFAULT 0,
    order_number integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.object_cost_plan OWNER TO postgres;

--
-- Name: TABLE object_cost_plan; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.object_cost_plan IS 'План затрат по объекту';


--
-- Name: COLUMN object_cost_plan.category; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_cost_plan.category IS 'Категория/статья затрат';


--
-- Name: COLUMN object_cost_plan.estimated_amount; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_cost_plan.estimated_amount IS 'Плановая сумма';


--
-- Name: COLUMN object_cost_plan.actual_amount; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_cost_plan.actual_amount IS 'Фактическая сумма';


--
-- Name: object_documents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.object_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    document_type public.object_document_type NOT NULL,
    name character varying(500) NOT NULL,
    signed_link text,
    editable_link text,
    document_number character varying(100),
    document_date date,
    order_number integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    notes text,
    parent_document_id uuid,
    signed_s3_document_id uuid,
    editable_s3_document_id uuid
);


ALTER TABLE public.object_documents OWNER TO postgres;

--
-- Name: TABLE object_documents; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.object_documents IS 'Документы объекта (договоры, приложения, ДС)';


--
-- Name: COLUMN object_documents.document_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_documents.document_type IS 'Тип документа: договор генподряда, приложение, доп. соглашение';


--
-- Name: COLUMN object_documents.name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_documents.name IS 'Наименование документа';


--
-- Name: COLUMN object_documents.signed_link; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_documents.signed_link IS 'DEPRECATED (task 282): внешняя ссылка Google Drive. Не используется в UI с 2026-05';


--
-- Name: COLUMN object_documents.editable_link; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_documents.editable_link IS 'DEPRECATED (task 282): внешняя ссылка Google Drive. Не используется в UI с 2026-05';


--
-- Name: COLUMN object_documents.document_number; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_documents.document_number IS 'Номер документа';


--
-- Name: COLUMN object_documents.document_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_documents.document_date IS 'Дата документа';


--
-- Name: COLUMN object_documents.order_number; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_documents.order_number IS 'Порядок сортировки внутри типа';


--
-- Name: COLUMN object_documents.notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_documents.notes IS 'Примечание к документу';


--
-- Name: COLUMN object_documents.signed_s3_document_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_documents.signed_s3_document_id IS 'FK на s3_documents для подписанного файла. NULL = файл не загружен';


--
-- Name: COLUMN object_documents.editable_s3_document_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_documents.editable_s3_document_id IS 'FK на s3_documents для редактируемого файла. NULL = файл не загружен';


--
-- Name: object_estimate_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.object_estimate_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    row_number integer NOT NULL,
    code character varying(50),
    cost_name text NOT NULL,
    unit character varying(50),
    quantity numeric(15,4),
    unit_price numeric(15,2) DEFAULT 0,
    total_price numeric(15,2) DEFAULT 0,
    is_section boolean DEFAULT false,
    original_row_number character varying(20),
    unit_price_materials numeric(15,2) DEFAULT 0,
    unit_price_works numeric(15,2) DEFAULT 0,
    vat_percent numeric(5,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    notes text,
    import_mode character varying(20) DEFAULT 'separate'::character varying,
    is_approved boolean DEFAULT false
);


ALTER TABLE public.object_estimate_items OWNER TO postgres;

--
-- Name: TABLE object_estimate_items; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.object_estimate_items IS 'Позиции сметы объекта';


--
-- Name: COLUMN object_estimate_items.unit_price_materials; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_estimate_items.unit_price_materials IS 'Цена за единицу по материалам (с НДС)';


--
-- Name: COLUMN object_estimate_items.unit_price_works; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_estimate_items.unit_price_works IS 'Цена за единицу по работам (с НДС)';


--
-- Name: COLUMN object_estimate_items.vat_percent; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_estimate_items.vat_percent IS '% НДС, учтённый в ценах';


--
-- Name: COLUMN object_estimate_items.notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_estimate_items.notes IS 'Примечание к позиции сметы';


--
-- Name: object_staff; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.object_staff (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    staff_role text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT object_staff_staff_role_check CHECK ((staff_role = ANY (ARRAY['construction_manager'::text, 'economist'::text])))
);


ALTER TABLE public.object_staff OWNER TO postgres;

--
-- Name: TABLE object_staff; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.object_staff IS 'Ответственные по объекту: руководители строительства и экономисты (несколько на объект)';


--
-- Name: COLUMN object_staff.staff_role; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_staff.staff_role IS 'Роль на объекте: construction_manager | economist';


--
-- Name: object_warranties; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.object_warranties (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    work_name text NOT NULL,
    start_date date,
    warranty_months integer DEFAULT 12 NOT NULL,
    order_number integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now(),
    start_type text DEFAULT 'date'::text NOT NULL,
    start_event_text text,
    start_document_id uuid,
    end_date_override date,
    notes text,
    actual_start_document_id uuid,
    CONSTRAINT object_warranties_start_type_check CHECK ((start_type = ANY (ARRAY['date'::text, 'event'::text])))
);


ALTER TABLE public.object_warranties OWNER TO postgres;

--
-- Name: COLUMN object_warranties.start_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_warranties.start_type IS 'date — начало по конкретной дате (start_date обязателен); event — начало по событию (start_event_text обязателен, start_date — фактическая дата когда событие наступит)';


--
-- Name: COLUMN object_warranties.start_event_text; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_warranties.start_event_text IS 'Текст события, например «с даты подписания Акта о практическом завершении Работ по Объекту (Акт № 3)»';


--
-- Name: COLUMN object_warranties.start_document_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_warranties.start_document_id IS 'Опциональная привязка к документу-акту из object_documents';


--
-- Name: COLUMN object_warranties.end_date_override; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_warranties.end_date_override IS 'Фиксированная дата окончания — имеет приоритет над авторасчётом start_date + warranty_months';


--
-- Name: COLUMN object_warranties.notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_warranties.notes IS 'Примечание (последняя колонка из договорной таблицы гарантий)';


--
-- Name: COLUMN object_warranties.actual_start_document_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_warranties.actual_start_document_id IS 'Файл подписанного акта, который запустил гарантию. Лежит в s3_documents с owner_type=object. На объектную модель документов (object_documents) не выходит — виден только в табе «Гарантия».';


--
-- Name: object_warranty_retention_payments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.object_warranty_retention_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    retention_id uuid NOT NULL,
    portion_text text NOT NULL,
    condition_text text NOT NULL,
    order_number integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.object_warranty_retention_payments OWNER TO postgres;

--
-- Name: TABLE object_warranty_retention_payments; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.object_warranty_retention_payments IS 'Части выплаты гарантийного удержания (1/3 с даты А, 2/3 с даты Б и т.п.). FK на object_warranty_retentions с ON DELETE CASCADE.';


--
-- Name: COLUMN object_warranty_retention_payments.portion_text; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_warranty_retention_payments.portion_text IS 'Доля от суммы удержания: «1/3», «2/3», «100%», «50%»';


--
-- Name: COLUMN object_warranty_retention_payments.condition_text; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.object_warranty_retention_payments.condition_text IS 'Описание условия выплаты, например «с даты получения Разрешения на ввод объекта в эксплуатацию»';


--
-- Name: object_warranty_retentions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.object_warranty_retentions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    retention_percent numeric(5,2) DEFAULT 0 NOT NULL,
    retention_period text,
    notes text,
    order_number integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.object_warranty_retentions OWNER TO postgres;

--
-- Name: positions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.positions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.positions OWNER TO postgres;

--
-- Name: TABLE positions; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.positions IS 'Справочник должностей сотрудников';


--
-- Name: psdc; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.psdc (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid,
    batch_id uuid,
    state text DEFAULT 'uploaded'::text NOT NULL,
    previous_psdc_id uuid,
    match_method text,
    match_note text,
    source_filename text NOT NULL,
    source_hash text,
    source_size bigint,
    source_s3_document_id uuid,
    sheet_name text,
    has_legacy_u boolean DEFAULT false NOT NULL,
    source_meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_row_count integer DEFAULT 0 NOT NULL,
    uploaded_by uuid,
    uploaded_by_name text,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    validated_at timestamp with time zone,
    applied_at timestamp with time zone,
    applied_by uuid,
    applied_by_name text,
    cancelled_at timestamp with time zone,
    deleted_at timestamp with time zone,
    deleted_by_name text,
    section_count integer,
    process_count integer,
    legacy_deleted_count integer,
    error_count integer DEFAULT 0 NOT NULL,
    warning_count integer DEFAULT 0 NOT NULL,
    total_material numeric(20,2),
    total_work numeric(20,2),
    total numeric(20,2),
    dm_material_excluded numeric(20,2),
    vat_rate_snapshot numeric(5,2),
    vat_included_snapshot boolean,
    vat_amount numeric(20,2),
    file_vat_rate numeric(7,2),
    legacy_total numeric(20,2),
    CONSTRAINT psdc_match_method_check CHECK ((match_method = ANY (ARRAY['auto'::text, 'manual'::text, 'table'::text, 'card'::text]))),
    CONSTRAINT psdc_state_check CHECK ((state = ANY (ARRAY['uploaded'::text, 'validated'::text, 'invalid'::text, 'applied'::text, 'cancelled'::text, 'deleted'::text])))
);


ALTER TABLE public.psdc OWNER TO postgres;

--
-- Name: TABLE psdc; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.psdc IS 'ПСДЦ / ВОР: одна загруженная ведомость. state: uploaded → validated|invalid → applied → deleted; незавершённая загрузка → cancelled';


--
-- Name: psdc_batches; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.psdc_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text,
    created_by uuid,
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.psdc_batches OWNER TO postgres;

--
-- Name: psdc_issues; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.psdc_issues (
    id bigint NOT NULL,
    psdc_id uuid NOT NULL,
    severity text NOT NULL,
    excel_row integer,
    cell text,
    field text,
    code text NOT NULL,
    message text NOT NULL,
    CONSTRAINT psdc_issues_severity_check CHECK ((severity = ANY (ARRAY['error'::text, 'warning'::text])))
);


ALTER TABLE public.psdc_issues OWNER TO postgres;

--
-- Name: TABLE psdc_issues; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.psdc_issues IS 'Ошибки/предупреждения проверки ПСДЦ с привязкой к строке и ячейке Excel';


--
-- Name: psdc_issues_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.psdc_issues_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.psdc_issues_id_seq OWNER TO postgres;

--
-- Name: psdc_issues_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.psdc_issues_id_seq OWNED BY public.psdc_issues.id;


--
-- Name: psdc_rows; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.psdc_rows (
    id uuid NOT NULL,
    psdc_id uuid NOT NULL,
    logical_line_id text NOT NULL,
    source_line_id text,
    row_order integer NOT NULL,
    excel_row integer NOT NULL,
    row_kind text,
    number text,
    resource_type text,
    code text,
    customer_material text,
    is_customer_material boolean DEFAULT false NOT NULL,
    cost_item text,
    name text,
    unit text,
    consumption_norm numeric(20,2),
    volume numeric(22,5),
    material_price numeric(20,2),
    material_cost numeric(20,2),
    work_price numeric(20,2),
    work_cost numeric(20,2),
    unit_price numeric(20,2),
    total_cost numeric(20,2),
    manufacturer text,
    materials text,
    work_location text,
    comment text,
    parent_section_id uuid,
    legacy_deleted boolean DEFAULT false NOT NULL,
    CONSTRAINT psdc_rows_row_kind_check CHECK ((row_kind = ANY (ARRAY['section'::text, 'process'::text])))
);


ALTER TABLE public.psdc_rows OWNER TO postgres;

--
-- Name: TABLE psdc_rows; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.psdc_rows IS 'Строки ПСДЦ после нормализации и расчёта (NUMERIC, округление на каждой строке)';


--
-- Name: psdc_source_rows; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.psdc_source_rows (
    psdc_id uuid NOT NULL,
    excel_row integer NOT NULL,
    cells jsonb NOT NULL
);


ALTER TABLE public.psdc_source_rows OWNER TO postgres;

--
-- Name: TABLE psdc_source_rows; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.psdc_source_rows IS 'Сырые значения ячеек XLSX строк ПСДЦ (исходное представление файла)';


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.role_permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role text NOT NULL,
    section text NOT NULL,
    can_view boolean DEFAULT true NOT NULL,
    can_edit boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.role_permissions OWNER TO postgres;

--
-- Name: roles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.roles (
    key text NOT NULL,
    label text NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.roles OWNER TO postgres;

--
-- Name: TABLE roles; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.roles IS 'Справочник ролей пользователей (динамический, управляется из админки)';


--
-- Name: COLUMN roles.key; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.roles.key IS 'Машинный ключ роли (используется в user_roles.role и role_permissions.role)';


--
-- Name: COLUMN roles.label; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.roles.label IS 'Отображаемое название роли в UI';


--
-- Name: COLUMN roles.is_system; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.roles.is_system IS 'Системные роли нельзя удалять через UI';


--
-- Name: s3_documents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.s3_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_type text NOT NULL,
    owner_id uuid NOT NULL,
    s3_key text NOT NULL,
    file_name text NOT NULL,
    mime_type text,
    size_bytes bigint,
    notes text,
    uploaded_by uuid,
    uploaded_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    doc_category text DEFAULT 'general'::text NOT NULL
);


ALTER TABLE public.s3_documents OWNER TO postgres;

--
-- Name: tender_vor_supply_rates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tender_vor_supply_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tender_id uuid,
    estimate_name text NOT NULL,
    material_name text NOT NULL,
    unit text,
    supply_price numeric(15,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.tender_vor_supply_rates OWNER TO postgres;

--
-- Name: TABLE tender_vor_supply_rates; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.tender_vor_supply_rates IS 'Расценки от снабжения на материалы ВОР тендера (task 398)';


--
-- Name: COLUMN tender_vor_supply_rates.tender_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_vor_supply_rates.tender_id IS 'Ссылка на тендер';


--
-- Name: COLUMN tender_vor_supply_rates.estimate_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_vor_supply_rates.estimate_name IS 'Имя ВОР-документа (estimate_name)';


--
-- Name: COLUMN tender_vor_supply_rates.material_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_vor_supply_rates.material_name IS 'Наименование материала';


--
-- Name: COLUMN tender_vor_supply_rates.unit; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_vor_supply_rates.unit IS 'Единица измерения';


--
-- Name: COLUMN tender_vor_supply_rates.supply_price; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_vor_supply_rates.supply_price IS 'Цена от снабжения за единицу';


--
-- Name: supply_rates_registry_mv; Type: MATERIALIZED VIEW; Schema: public; Owner: postgres
--

CREATE MATERIALIZED VIEW public.supply_rates_registry_mv AS
 SELECT DISTINCT ON (sr.tender_id, (public.kp_norm_name(sr.material_name)), (public.kp_norm_unit(sr.unit))) md5((((((sr.tender_id)::text || '|'::text) || public.kp_norm_name(sr.material_name)) || '|'::text) || public.kp_norm_unit(sr.unit))) AS id,
    'supply_su10'::text AS source_type,
    'СУ-10'::text AS source_name,
    sr.material_name AS item_name,
    sr.unit,
    sr.supply_price AS price,
    sr.tender_id,
    t.object_id,
    t.work_description AS tender_desc,
    o.name AS object_name,
    COALESCE(sr.updated_at, sr.created_at) AS rate_date
   FROM ((public.tender_vor_supply_rates sr
     JOIN public.tenders t ON ((t.id = sr.tender_id)))
     LEFT JOIN public.objects o ON ((o.id = t.object_id)))
  WHERE (public.kp_norm_name(sr.material_name) <> ''::text)
  ORDER BY sr.tender_id, (public.kp_norm_name(sr.material_name)), (public.kp_norm_unit(sr.unit)), COALESCE(sr.updated_at, sr.created_at) DESC NULLS LAST
  WITH NO DATA;


ALTER MATERIALIZED VIEW public.supply_rates_registry_mv OWNER TO postgres;

--
-- Name: MATERIALIZED VIEW supply_rates_registry_mv; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON MATERIALIZED VIEW public.supply_rates_registry_mv IS 'Реестр расценок снабжения СУ-10. Обновляется refresh_rates_registry()';


--
-- Name: supply_rates_registry; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.supply_rates_registry AS
 SELECT id,
    source_type,
    source_name,
    item_name,
    unit,
    price,
    tender_id,
    object_id,
    tender_desc,
    object_name,
    rate_date
   FROM public.supply_rates_registry_mv;


ALTER VIEW public.supply_rates_registry OWNER TO postgres;

--
-- Name: supply_rates_registry_filter_objects; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.supply_rates_registry_filter_objects AS
 SELECT DISTINCT object_id,
    object_name
   FROM public.supply_rates_registry_mv r
  WHERE (object_id IS NOT NULL);


ALTER VIEW public.supply_rates_registry_filter_objects OWNER TO postgres;

--
-- Name: supply_rates_registry_filter_tenders; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.supply_rates_registry_filter_tenders AS
 SELECT DISTINCT tender_id,
    tender_desc,
    object_id
   FROM public.supply_rates_registry_mv r
  WHERE ((tender_id IS NOT NULL) AND (COALESCE(tender_desc, ''::text) <> ''::text));


ALTER VIEW public.supply_rates_registry_filter_tenders OWNER TO postgres;

--
-- Name: supply_rates_registry_units; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.supply_rates_registry_units AS
 SELECT DISTINCT unit
   FROM public.supply_rates_registry_mv
  WHERE ((unit IS NOT NULL) AND (unit <> ''::text));


ALTER VIEW public.supply_rates_registry_units OWNER TO postgres;

--
-- Name: task_audit_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.task_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    event_type text NOT NULL,
    field_name text,
    old_value jsonb,
    new_value jsonb,
    description text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by_role text,
    changed_by_name text
);


ALTER TABLE public.task_audit_log OWNER TO postgres;

--
-- Name: task_checklist_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.task_checklist_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    title text NOT NULL,
    is_done boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.task_checklist_items OWNER TO postgres;

--
-- Name: task_comments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.task_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    author_user_id uuid,
    author_name text,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.task_comments OWNER TO postgres;

--
-- Name: task_participants; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.task_participants (
    task_id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_participants_kind_check CHECK ((kind = ANY (ARRAY['coassignee'::text, 'watcher'::text])))
);


ALTER TABLE public.task_participants OWNER TO postgres;

--
-- Name: TABLE task_participants; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.task_participants IS 'Соисполнители (coassignee) и наблюдатели (watcher) задачи';


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    assignee_user_id uuid,
    created_by_user_id uuid,
    due_date date,
    completed_at timestamp with time zone,
    object_id uuid,
    tender_id uuid,
    contract_id uuid,
    sort_order integer DEFAULT 0 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tasks_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text]))),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['new'::text, 'in_progress'::text, 'review'::text, 'done'::text, 'deferred'::text])))
);


ALTER TABLE public.tasks OWNER TO postgres;

--
-- Name: TABLE tasks; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.tasks IS 'Задачи сотрудникам (task 433)';


--
-- Name: COLUMN tasks.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tasks.status IS 'new | in_progress | review (на приёмке у постановщика) | done | deferred';


--
-- Name: COLUMN tasks.priority; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tasks.priority IS 'low | normal | high';


--
-- Name: COLUMN tasks.assignee_user_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tasks.assignee_user_id IS 'Ответственный — auth.users.id (без FK, как user_roles.user_id)';


--
-- Name: COLUMN tasks.created_by_user_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tasks.created_by_user_id IS 'Постановщик — auth.users.id; он принимает работу из статуса review';


--
-- Name: COLUMN tasks.sort_order; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tasks.sort_order IS 'Порядок карточки внутри колонки канбан-доски';


--
-- Name: tender_audit_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tender_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tender_id uuid NOT NULL,
    event_type text NOT NULL,
    field_name text,
    old_value jsonb,
    new_value jsonb,
    description text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by_role text,
    changed_by_name text
);


ALTER TABLE public.tender_audit_log OWNER TO postgres;

--
-- Name: TABLE tender_audit_log; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.tender_audit_log IS 'Аудит-лог изменений тендеров (создание, смена статуса, выбор победителя, изменения полей)';


--
-- Name: COLUMN tender_audit_log.event_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_audit_log.event_type IS 'Тип события: created | status_changed | winner_assigned | field_updated';


--
-- Name: COLUMN tender_audit_log.field_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_audit_log.field_name IS 'Имя поля для event_type=field_updated';


--
-- Name: COLUMN tender_audit_log.old_value; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_audit_log.old_value IS 'Прежнее значение (JSONB)';


--
-- Name: COLUMN tender_audit_log.new_value; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_audit_log.new_value IS 'Новое значение (JSONB)';


--
-- Name: COLUMN tender_audit_log.description; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_audit_log.description IS 'Человекочитаемое описание для отображения в UI';


--
-- Name: COLUMN tender_audit_log.changed_by_role; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_audit_log.changed_by_role IS 'Роль пользователя из localStorage(userRole)';


--
-- Name: COLUMN tender_audit_log.changed_by_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_audit_log.changed_by_name IS 'ФИО пользователя из user_roles, если доступно';


--
-- Name: tender_counterparties; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tender_counterparties (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tender_id uuid NOT NULL,
    counterparty_id uuid NOT NULL,
    invited_at timestamp with time zone DEFAULT now(),
    notes text,
    status public.tender_counterparty_status DEFAULT 'request_sent'::public.tender_counterparty_status,
    proposal_link text,
    sort_order integer DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.tender_counterparties REPLICA IDENTITY FULL;


ALTER TABLE public.tender_counterparties OWNER TO postgres;

--
-- Name: TABLE tender_counterparties; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.tender_counterparties IS 'Связь между тендерами и приглашенными контрагентами';


--
-- Name: COLUMN tender_counterparties.id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparties.id IS 'Уникальный идентификатор связи';


--
-- Name: COLUMN tender_counterparties.tender_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparties.tender_id IS 'Ссылка на тендер';


--
-- Name: COLUMN tender_counterparties.counterparty_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparties.counterparty_id IS 'Ссылка на контрагента';


--
-- Name: COLUMN tender_counterparties.invited_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparties.invited_at IS 'Дата и время приглашения контрагента';


--
-- Name: COLUMN tender_counterparties.notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparties.notes IS 'Примечания к участию контрагента в тендере';


--
-- Name: COLUMN tender_counterparties.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparties.status IS 'Статус участия контрагента в тендере (Запрос отправлен, Отказ, КП предоставлено, Принято в работу)';


--
-- Name: COLUMN tender_counterparties.proposal_link; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparties.proposal_link IS 'Ссылка на коммерческое предложение контрагента (Google/Yandex Drive)';


--
-- Name: COLUMN tender_counterparties.sort_order; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_counterparties.sort_order IS 'Порядок участника в списке тендера (drag-and-drop). Шаг 10.';


--
-- Name: tender_doc_links; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tender_doc_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tender_doc_id uuid NOT NULL,
    title text,
    url text NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.tender_doc_links OWNER TO postgres;

--
-- Name: tender_docs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tender_docs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tender_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    is_final boolean DEFAULT false NOT NULL,
    sort_order integer,
    created_by uuid,
    created_by_name text,
    updated_by uuid,
    updated_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.tender_docs OWNER TO postgres;

--
-- Name: tender_documents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tender_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tender_id uuid NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    document_type text DEFAULT 'attachment'::text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.tender_documents OWNER TO postgres;

--
-- Name: tender_proposal_files; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tender_proposal_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tender_id uuid NOT NULL,
    counterparty_id uuid NOT NULL,
    s3_document_id uuid NOT NULL,
    file_kind text NOT NULL,
    proposal_group_id uuid,
    version_label text,
    created_at timestamp with time zone DEFAULT now(),
    review_status text DEFAULT 'pending'::text NOT NULL,
    review_note text,
    reviewed_at timestamp with time zone,
    reviewed_by text,
    review_required boolean DEFAULT true NOT NULL,
    review_note_s3_document_id uuid,
    remarks_sent boolean DEFAULT false NOT NULL,
    remarks_sent_at timestamp with time zone,
    remarks_sent_by text,
    summary_added boolean DEFAULT false NOT NULL,
    summary_added_at timestamp with time zone,
    summary_added_by text,
    remarks_send_required boolean DEFAULT true NOT NULL,
    CONSTRAINT tender_proposal_files_file_kind_check CHECK ((file_kind = ANY (ARRAY['commercial_proposal'::text, 'attachment'::text]))),
    CONSTRAINT tender_proposal_files_review_status_check CHECK ((review_status = ANY (ARRAY['pending'::text, 'approved'::text, 'has_remarks'::text])))
);


ALTER TABLE public.tender_proposal_files OWNER TO postgres;

--
-- Name: TABLE tender_proposal_files; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.tender_proposal_files IS 'Файлы КП/документов от контрагентов по тендеру. Связь с s3_documents через s3_document_id.';


--
-- Name: COLUMN tender_proposal_files.file_kind; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_proposal_files.file_kind IS 'commercial_proposal — это КП; attachment — вспомогательный документ';


--
-- Name: COLUMN tender_proposal_files.proposal_group_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_proposal_files.proposal_group_id IS 'Идентификатор группы версий одного КП (исходный → со скидкой → финальный). NULL для attachment.';


--
-- Name: COLUMN tender_proposal_files.version_label; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_proposal_files.version_label IS 'Свободная метка версии: исходный, со скидкой 5%, финальный и т.п.';


--
-- Name: COLUMN tender_proposal_files.review_status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_proposal_files.review_status IS 'Статус проверки КП аналитиком: pending | approved | has_remarks';


--
-- Name: COLUMN tender_proposal_files.review_note; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_proposal_files.review_note IS 'Замечания аналитика по КП (для has_remarks)';


--
-- Name: COLUMN tender_proposal_files.reviewed_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_proposal_files.reviewed_at IS 'Момент завершения проверки';


--
-- Name: COLUMN tender_proposal_files.reviewed_by; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_proposal_files.reviewed_by IS 'Кто проверил (ФИО или e-mail из профиля)';


--
-- Name: COLUMN tender_proposal_files.review_required; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_proposal_files.review_required IS 'Попадает ли КП в очередь «Проверка КП». Легаси (до миграции) = false, новые загрузки = true';


--
-- Name: COLUMN tender_proposal_files.review_note_s3_document_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_proposal_files.review_note_s3_document_id IS 'Файл с замечаниями (S3), прикреплённый аналитиком при has_remarks';


--
-- Name: COLUMN tender_proposal_files.remarks_sent; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_proposal_files.remarks_sent IS 'Замечания по КП отправлены контрагенту (инженером)';


--
-- Name: COLUMN tender_proposal_files.remarks_sent_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_proposal_files.remarks_sent_at IS 'Когда отмечена отправка замечаний контрагенту';


--
-- Name: COLUMN tender_proposal_files.remarks_sent_by; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_proposal_files.remarks_sent_by IS 'Кто отметил отправку замечаний (ФИО/e-mail)';


--
-- Name: COLUMN tender_proposal_files.summary_added; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_proposal_files.summary_added IS 'КП занесено в сводную таблицу. Этап между проверкой аналитиком и отправкой замечаний контрагенту';


--
-- Name: COLUMN tender_proposal_files.remarks_send_required; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_proposal_files.remarks_send_required IS 'Ветка обработки замечаний: true — замечания направляются подрядчику, false — обрабатываются без отправки (маршрут заканчивается на занесении в сводную)';


--
-- Name: tender_rd_codes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tender_rd_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tender_id uuid NOT NULL,
    code text NOT NULL,
    title text,
    notes text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    created_by_name text
);


ALTER TABLE public.tender_rd_codes OWNER TO postgres;

--
-- Name: TABLE tender_rd_codes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.tender_rd_codes IS 'Шифры рабочей документации по тендеру (несколько на тендер)';


--
-- Name: COLUMN tender_rd_codes.code; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_rd_codes.code IS 'Шифр РД, как в документации (например 2024-15-АР)';


--
-- Name: COLUMN tender_rd_codes.title; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_rd_codes.title IS 'Наименование раздела РД';


--
-- Name: tender_rd_document_codes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tender_rd_document_codes (
    document_id uuid NOT NULL,
    rd_code_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    created_by_name text
);


ALTER TABLE public.tender_rd_document_codes OWNER TO postgres;

--
-- Name: TABLE tender_rd_document_codes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.tender_rd_document_codes IS 'Связь PDF рабочей документации тендера (s3_documents, doc_category=rd) с шифрами РД (tender_rd_codes)';


--
-- Name: tender_winners; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tender_winners (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tender_id uuid NOT NULL,
    counterparty_id uuid NOT NULL,
    scope_note text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.tender_winners OWNER TO postgres;

--
-- Name: TABLE tender_winners; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.tender_winners IS 'Победители тендера (несколько — при разделении по корпусам/системам)';


--
-- Name: COLUMN tender_winners.scope_note; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tender_winners.scope_note IS 'Корпус/система, по которой контрагент признан победителем';


--
-- Name: vor_requests; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.vor_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_number integer NOT NULL,
    department text DEFAULT 'construction'::text NOT NULL,
    object_id uuid,
    work_description text NOT NULL,
    notes text,
    vor_status text DEFAULT 'not_started'::text NOT NULL,
    vor_division text,
    vor_sto_user_id uuid,
    vor_sto_name text,
    vor_end_date date,
    vor_link text,
    tender_id uuid,
    created_by uuid DEFAULT auth.uid(),
    created_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT vor_requests_department_check CHECK ((department = ANY (ARRAY['construction'::text, 'joint'::text]))),
    CONSTRAINT vor_requests_description_check CHECK ((btrim(work_description) <> ''::text)),
    CONSTRAINT vor_requests_division_check CHECK (((vor_division IS NULL) OR (vor_division = ANY (ARRAY['monolith'::text, 'nvf_spk'::text, 'general'::text, 'hvac_water'::text, 'electrical'::text])))),
    CONSTRAINT vor_requests_status_check CHECK ((vor_status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'completed'::text, 'not_required'::text])))
);


ALTER TABLE public.vor_requests OWNER TO postgres;

--
-- Name: TABLE vor_requests; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.vor_requests IS 'Заявки на подготовку ВОР без привязки к тендеру (раздел «ВОРы и РД»).';


--
-- Name: vor_requests_number_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.vor_requests_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.vor_requests_number_seq OWNER TO postgres;

--
-- Name: vor_requests_number_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.vor_requests_number_seq OWNED BY public.vor_requests.request_number;


--
-- Name: work_types; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.work_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.work_types OWNER TO postgres;

--
-- Name: TABLE work_types; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.work_types IS 'Справочник видов работ контрагентов (task 321)';


--
-- Name: refresh_tokens id; Type: DEFAULT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('auth.refresh_tokens_id_seq'::regclass);


--
-- Name: client_errors id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_errors ALTER COLUMN id SET DEFAULT nextval('public.client_errors_id_seq'::regclass);


--
-- Name: contracts display_id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contracts ALTER COLUMN display_id SET DEFAULT nextval('public.contracts_display_id_seq'::regclass);


--
-- Name: psdc_issues id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.psdc_issues ALTER COLUMN id SET DEFAULT nextval('public.psdc_issues_id_seq'::regclass);


--
-- Name: vor_requests request_number; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.vor_requests ALTER COLUMN request_number SET DEFAULT nextval('public.vor_requests_number_seq'::regclass);


--
-- Name: mfa_amr_claims amr_id_pk; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT amr_id_pk PRIMARY KEY (id);


--
-- Name: audit_log_entries audit_log_entries_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.audit_log_entries
    ADD CONSTRAINT audit_log_entries_pkey PRIMARY KEY (id);


--
-- Name: custom_oauth_providers custom_oauth_providers_identifier_key; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.custom_oauth_providers
    ADD CONSTRAINT custom_oauth_providers_identifier_key UNIQUE (identifier);


--
-- Name: custom_oauth_providers custom_oauth_providers_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.custom_oauth_providers
    ADD CONSTRAINT custom_oauth_providers_pkey PRIMARY KEY (id);


--
-- Name: flow_state flow_state_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.flow_state
    ADD CONSTRAINT flow_state_pkey PRIMARY KEY (id);


--
-- Name: identities identities_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_pkey PRIMARY KEY (id);


--
-- Name: identities identities_provider_id_provider_unique; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_provider_id_provider_unique UNIQUE (provider_id, provider);


--
-- Name: instances instances_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.instances
    ADD CONSTRAINT instances_pkey PRIMARY KEY (id);


--
-- Name: mfa_amr_claims mfa_amr_claims_session_id_authentication_method_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT mfa_amr_claims_session_id_authentication_method_pkey UNIQUE (session_id, authentication_method);


--
-- Name: mfa_challenges mfa_challenges_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_challenges
    ADD CONSTRAINT mfa_challenges_pkey PRIMARY KEY (id);


--
-- Name: mfa_factors mfa_factors_last_challenged_at_key; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_last_challenged_at_key UNIQUE (last_challenged_at);


--
-- Name: mfa_factors mfa_factors_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_pkey PRIMARY KEY (id);


--
-- Name: mfa_recovery_code_sets mfa_recovery_code_sets_mfa_factor_id_key; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_recovery_code_sets
    ADD CONSTRAINT mfa_recovery_code_sets_mfa_factor_id_key UNIQUE (mfa_factor_id);


--
-- Name: mfa_recovery_code_sets mfa_recovery_code_sets_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_recovery_code_sets
    ADD CONSTRAINT mfa_recovery_code_sets_pkey PRIMARY KEY (id);


--
-- Name: mfa_recovery_code_sets mfa_recovery_code_sets_user_id_key; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_recovery_code_sets
    ADD CONSTRAINT mfa_recovery_code_sets_user_id_key UNIQUE (user_id);


--
-- Name: mfa_recovery_codes mfa_recovery_codes_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_recovery_codes
    ADD CONSTRAINT mfa_recovery_codes_pkey PRIMARY KEY (id);


--
-- Name: oauth_authorizations oauth_authorizations_authorization_code_key; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_authorization_code_key UNIQUE (authorization_code);


--
-- Name: oauth_authorizations oauth_authorizations_authorization_id_key; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_authorization_id_key UNIQUE (authorization_id);


--
-- Name: oauth_authorizations oauth_authorizations_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_pkey PRIMARY KEY (id);


--
-- Name: oauth_client_states oauth_client_states_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_client_states
    ADD CONSTRAINT oauth_client_states_pkey PRIMARY KEY (id);


--
-- Name: oauth_clients oauth_clients_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (id);


--
-- Name: oauth_consents oauth_consents_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_consents
    ADD CONSTRAINT oauth_consents_pkey PRIMARY KEY (id);


--
-- Name: oauth_consents oauth_consents_user_client_unique; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_consents
    ADD CONSTRAINT oauth_consents_user_client_unique UNIQUE (user_id, client_id);


--
-- Name: one_time_tokens one_time_tokens_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.one_time_tokens
    ADD CONSTRAINT one_time_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_unique; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_unique UNIQUE (token);


--
-- Name: saml_providers saml_providers_entity_id_key; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_entity_id_key UNIQUE (entity_id);


--
-- Name: saml_providers saml_providers_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_pkey PRIMARY KEY (id);


--
-- Name: saml_relay_states saml_relay_states_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: scim_tokens scim_tokens_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.scim_tokens
    ADD CONSTRAINT scim_tokens_pkey PRIMARY KEY (id);


--
-- Name: scim_users scim_users_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.scim_users
    ADD CONSTRAINT scim_users_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sso_domains sso_domains_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.sso_domains
    ADD CONSTRAINT sso_domains_pkey PRIMARY KEY (id);


--
-- Name: sso_providers sso_providers_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.sso_providers
    ADD CONSTRAINT sso_providers_pkey PRIMARY KEY (id);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: webauthn_challenges webauthn_challenges_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_pkey PRIMARY KEY (id);


--
-- Name: webauthn_credentials webauthn_credentials_pkey; Type: CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_pkey PRIMARY KEY (id);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);


--
-- Name: bsm_supply_rates bsm_approved_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bsm_supply_rates
    ADD CONSTRAINT bsm_approved_rates_pkey PRIMARY KEY (id);


--
-- Name: bsm_contract_rates bsm_contract_rates_object_id_material_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bsm_contract_rates
    ADD CONSTRAINT bsm_contract_rates_object_id_material_name_key UNIQUE (object_id, material_name);


--
-- Name: bsm_contract_rates bsm_contract_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bsm_contract_rates
    ADD CONSTRAINT bsm_contract_rates_pkey PRIMARY KEY (id);


--
-- Name: bsm_contractor_rates bsm_contractor_rates_object_id_counterparty_id_material_nam_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bsm_contractor_rates
    ADD CONSTRAINT bsm_contractor_rates_object_id_counterparty_id_material_nam_key UNIQUE (object_id, counterparty_id, material_name);


--
-- Name: bsm_contractor_rates bsm_contractor_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bsm_contractor_rates
    ADD CONSTRAINT bsm_contractor_rates_pkey PRIMARY KEY (id);


--
-- Name: client_errors client_errors_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_errors
    ADD CONSTRAINT client_errors_pkey PRIMARY KEY (id);


--
-- Name: client_versions client_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.client_versions
    ADD CONSTRAINT client_versions_pkey PRIMARY KEY (user_id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: contract_advance_schedule contract_advance_schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_advance_schedule
    ADD CONSTRAINT contract_advance_schedule_pkey PRIMARY KEY (id);


--
-- Name: contract_appendices contract_appendices_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_appendices
    ADD CONSTRAINT contract_appendices_pkey PRIMARY KEY (id);


--
-- Name: contract_attachments contract_attachments_contract_id_attachment_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_attachments
    ADD CONSTRAINT contract_attachments_contract_id_attachment_id_key UNIQUE (contract_id, attachment_id);


--
-- Name: contract_attachments contract_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_attachments
    ADD CONSTRAINT contract_attachments_pkey PRIMARY KEY (id);


--
-- Name: contract_audit_log contract_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_audit_log
    ADD CONSTRAINT contract_audit_log_pkey PRIMARY KEY (id);


--
-- Name: contract_clause_comments contract_clause_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_clause_comments
    ADD CONSTRAINT contract_clause_comments_pkey PRIMARY KEY (id);


--
-- Name: contract_clause_dispute_clauses contract_clause_dispute_clauses_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_clause_dispute_clauses
    ADD CONSTRAINT contract_clause_dispute_clauses_pkey PRIMARY KEY (dispute_id, clause_id);


--
-- Name: contract_clause_disputes contract_clause_disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_clause_disputes
    ADD CONSTRAINT contract_clause_disputes_pkey PRIMARY KEY (id);


--
-- Name: contract_clauses contract_clauses_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_clauses
    ADD CONSTRAINT contract_clauses_pkey PRIMARY KEY (id);


--
-- Name: contract_counterparties contract_counterparties_contract_id_counterparty_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_counterparties
    ADD CONSTRAINT contract_counterparties_contract_id_counterparty_id_key UNIQUE (contract_id, counterparty_id);


--
-- Name: contract_counterparties contract_counterparties_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_counterparties
    ADD CONSTRAINT contract_counterparties_pkey PRIMARY KEY (id);


--
-- Name: contract_psdc_items contract_psdc_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_psdc_items
    ADD CONSTRAINT contract_psdc_items_pkey PRIMARY KEY (id);


--
-- Name: contracts contracts_display_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_display_id_key UNIQUE (display_id);


--
-- Name: contracts contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_pkey PRIMARY KEY (id);


--
-- Name: counterparties counterparties_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.counterparties
    ADD CONSTRAINT counterparties_pkey PRIMARY KEY (id);


--
-- Name: counterparty_audit_log counterparty_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.counterparty_audit_log
    ADD CONSTRAINT counterparty_audit_log_pkey PRIMARY KEY (id);


--
-- Name: counterparty_contacts counterparty_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.counterparty_contacts
    ADD CONSTRAINT counterparty_contacts_pkey PRIMARY KEY (id);


--
-- Name: counterparty_relations counterparty_relations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.counterparty_relations
    ADD CONSTRAINT counterparty_relations_pkey PRIMARY KEY (id);


--
-- Name: dc_request_audit_log dc_request_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dc_request_audit_log
    ADD CONSTRAINT dc_request_audit_log_pkey PRIMARY KEY (id);


--
-- Name: dc_request_tasks dc_request_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dc_request_tasks
    ADD CONSTRAINT dc_request_tasks_pkey PRIMARY KEY (id);


--
-- Name: dc_requests dc_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dc_requests
    ADD CONSTRAINT dc_requests_pkey PRIMARY KEY (id);


--
-- Name: departments departments_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_name_key UNIQUE (name);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);


--
-- Name: doc_check_request_audit_log doc_check_request_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.doc_check_request_audit_log
    ADD CONSTRAINT doc_check_request_audit_log_pkey PRIMARY KEY (id);


--
-- Name: doc_check_requests doc_check_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.doc_check_requests
    ADD CONSTRAINT doc_check_requests_pkey PRIMARY KEY (id);


--
-- Name: document_check_requests document_check_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.document_check_requests
    ADD CONSTRAINT document_check_requests_pkey PRIMARY KEY (id);


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);


--
-- Name: general_document_folders general_document_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.general_document_folders
    ADD CONSTRAINT general_document_folders_pkey PRIMARY KEY (id);


--
-- Name: general_document_links general_document_links_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.general_document_links
    ADD CONSTRAINT general_document_links_pkey PRIMARY KEY (id);


--
-- Name: general_documents general_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.general_documents
    ADD CONSTRAINT general_documents_pkey PRIMARY KEY (id);


--
-- Name: object_areas object_areas_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_areas
    ADD CONSTRAINT object_areas_pkey PRIMARY KEY (id);


--
-- Name: object_contract_attachments object_contract_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_contract_attachments
    ADD CONSTRAINT object_contract_attachments_pkey PRIMARY KEY (id);


--
-- Name: object_cost_plan object_cost_plan_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_cost_plan
    ADD CONSTRAINT object_cost_plan_pkey PRIMARY KEY (id);


--
-- Name: object_documents object_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_documents
    ADD CONSTRAINT object_documents_pkey PRIMARY KEY (id);


--
-- Name: object_estimate_items object_estimate_items_object_id_row_number_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_estimate_items
    ADD CONSTRAINT object_estimate_items_object_id_row_number_key UNIQUE (object_id, row_number);


--
-- Name: object_estimate_items object_estimate_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_estimate_items
    ADD CONSTRAINT object_estimate_items_pkey PRIMARY KEY (id);


--
-- Name: object_staff object_staff_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_staff
    ADD CONSTRAINT object_staff_pkey PRIMARY KEY (id);


--
-- Name: object_staff object_staff_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_staff
    ADD CONSTRAINT object_staff_unique UNIQUE (object_id, contact_id, staff_role);


--
-- Name: object_warranties object_warranties_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_warranties
    ADD CONSTRAINT object_warranties_pkey PRIMARY KEY (id);


--
-- Name: object_warranty_retention_payments object_warranty_retention_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_warranty_retention_payments
    ADD CONSTRAINT object_warranty_retention_payments_pkey PRIMARY KEY (id);


--
-- Name: object_warranty_retentions object_warranty_retentions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_warranty_retentions
    ADD CONSTRAINT object_warranty_retentions_pkey PRIMARY KEY (id);


--
-- Name: objects objects_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_pkey PRIMARY KEY (id);


--
-- Name: positions positions_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT positions_name_key UNIQUE (name);


--
-- Name: positions positions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT positions_pkey PRIMARY KEY (id);


--
-- Name: psdc_batches psdc_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.psdc_batches
    ADD CONSTRAINT psdc_batches_pkey PRIMARY KEY (id);


--
-- Name: psdc_issues psdc_issues_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.psdc_issues
    ADD CONSTRAINT psdc_issues_pkey PRIMARY KEY (id);


--
-- Name: psdc psdc_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.psdc
    ADD CONSTRAINT psdc_pkey PRIMARY KEY (id);


--
-- Name: psdc_rows psdc_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.psdc_rows
    ADD CONSTRAINT psdc_rows_pkey PRIMARY KEY (id);


--
-- Name: psdc_source_rows psdc_source_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.psdc_source_rows
    ADD CONSTRAINT psdc_source_rows_pkey PRIMARY KEY (psdc_id, excel_row);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (key);


--
-- Name: s3_documents s3_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.s3_documents
    ADD CONSTRAINT s3_documents_pkey PRIMARY KEY (id);


--
-- Name: s3_documents s3_documents_s3_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.s3_documents
    ADD CONSTRAINT s3_documents_s3_key_key UNIQUE (s3_key);


--
-- Name: task_audit_log task_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_audit_log
    ADD CONSTRAINT task_audit_log_pkey PRIMARY KEY (id);


--
-- Name: task_checklist_items task_checklist_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_checklist_items
    ADD CONSTRAINT task_checklist_items_pkey PRIMARY KEY (id);


--
-- Name: task_comments task_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_pkey PRIMARY KEY (id);


--
-- Name: task_participants task_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_participants
    ADD CONSTRAINT task_participants_pkey PRIMARY KEY (task_id, user_id, kind);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: tender_audit_log tender_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_audit_log
    ADD CONSTRAINT tender_audit_log_pkey PRIMARY KEY (id);


--
-- Name: tender_counterparties tender_counterparties_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_counterparties
    ADD CONSTRAINT tender_counterparties_pkey PRIMARY KEY (id);


--
-- Name: tender_counterparties tender_counterparties_tender_id_counterparty_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_counterparties
    ADD CONSTRAINT tender_counterparties_tender_id_counterparty_id_key UNIQUE (tender_id, counterparty_id);


--
-- Name: tender_counterparty_proposals tender_counterparty_proposals_estimate_item_id_counterparty_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_counterparty_proposals
    ADD CONSTRAINT tender_counterparty_proposals_estimate_item_id_counterparty_key UNIQUE (estimate_item_id, counterparty_id);


--
-- Name: tender_counterparty_proposals tender_counterparty_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_counterparty_proposals
    ADD CONSTRAINT tender_counterparty_proposals_pkey PRIMARY KEY (id);


--
-- Name: tender_doc_links tender_doc_links_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_doc_links
    ADD CONSTRAINT tender_doc_links_pkey PRIMARY KEY (id);


--
-- Name: tender_docs tender_docs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_docs
    ADD CONSTRAINT tender_docs_pkey PRIMARY KEY (id);


--
-- Name: tender_documents tender_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_documents
    ADD CONSTRAINT tender_documents_pkey PRIMARY KEY (id);


--
-- Name: tender_estimate_items tender_estimate_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_estimate_items
    ADD CONSTRAINT tender_estimate_items_pkey PRIMARY KEY (id);


--
-- Name: tender_estimate_items tender_estimate_items_tender_id_estimate_row_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_estimate_items
    ADD CONSTRAINT tender_estimate_items_tender_id_estimate_row_key UNIQUE (tender_id, estimate_name, row_number);


--
-- Name: tender_proposal_files tender_proposal_files_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_proposal_files
    ADD CONSTRAINT tender_proposal_files_pkey PRIMARY KEY (id);


--
-- Name: tender_rd_codes tender_rd_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_rd_codes
    ADD CONSTRAINT tender_rd_codes_pkey PRIMARY KEY (id);


--
-- Name: tender_rd_document_codes tender_rd_document_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_rd_document_codes
    ADD CONSTRAINT tender_rd_document_codes_pkey PRIMARY KEY (document_id, rd_code_id);


--
-- Name: tender_vor_supply_rates tender_vor_supply_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_vor_supply_rates
    ADD CONSTRAINT tender_vor_supply_rates_pkey PRIMARY KEY (id);


--
-- Name: tender_vor_supply_rates tender_vor_supply_rates_tender_id_estimate_name_material_na_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_vor_supply_rates
    ADD CONSTRAINT tender_vor_supply_rates_tender_id_estimate_name_material_na_key UNIQUE (tender_id, estimate_name, material_name);


--
-- Name: tender_winners tender_winners_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_winners
    ADD CONSTRAINT tender_winners_pkey PRIMARY KEY (id);


--
-- Name: tender_winners tender_winners_tender_id_counterparty_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_winners
    ADD CONSTRAINT tender_winners_tender_id_counterparty_id_key UNIQUE (tender_id, counterparty_id);


--
-- Name: tenders tenders_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenders
    ADD CONSTRAINT tenders_pkey PRIMARY KEY (id);


--
-- Name: counterparty_relations unique_relation; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.counterparty_relations
    ADD CONSTRAINT unique_relation UNIQUE (counterparty_id, related_counterparty_id);


--
-- Name: role_permissions unique_role_section; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT unique_role_section UNIQUE (role, section);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_key UNIQUE (user_id);


--
-- Name: vor_requests vor_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.vor_requests
    ADD CONSTRAINT vor_requests_pkey PRIMARY KEY (id);


--
-- Name: vor_requests vor_requests_request_number_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.vor_requests
    ADD CONSTRAINT vor_requests_request_number_key UNIQUE (request_number);


--
-- Name: work_types work_types_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.work_types
    ADD CONSTRAINT work_types_name_key UNIQUE (name);


--
-- Name: work_types work_types_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.work_types
    ADD CONSTRAINT work_types_pkey PRIMARY KEY (id);


--
-- Name: audit_logs_instance_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX audit_logs_instance_id_idx ON auth.audit_log_entries USING btree (instance_id);


--
-- Name: confirmation_token_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX confirmation_token_idx ON auth.users USING btree (confirmation_token) WHERE ((confirmation_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: custom_oauth_providers_created_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX custom_oauth_providers_created_at_idx ON auth.custom_oauth_providers USING btree (created_at);


--
-- Name: custom_oauth_providers_enabled_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX custom_oauth_providers_enabled_idx ON auth.custom_oauth_providers USING btree (enabled);


--
-- Name: custom_oauth_providers_identifier_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX custom_oauth_providers_identifier_idx ON auth.custom_oauth_providers USING btree (identifier);


--
-- Name: custom_oauth_providers_provider_type_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX custom_oauth_providers_provider_type_idx ON auth.custom_oauth_providers USING btree (provider_type);


--
-- Name: email_change_token_current_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX email_change_token_current_idx ON auth.users USING btree (email_change_token_current) WHERE ((email_change_token_current)::text !~ '^[0-9 ]*$'::text);


--
-- Name: email_change_token_new_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX email_change_token_new_idx ON auth.users USING btree (email_change_token_new) WHERE ((email_change_token_new)::text !~ '^[0-9 ]*$'::text);


--
-- Name: factor_id_created_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX factor_id_created_at_idx ON auth.mfa_factors USING btree (user_id, created_at);


--
-- Name: flow_state_created_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX flow_state_created_at_idx ON auth.flow_state USING btree (created_at DESC);


--
-- Name: identities_email_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX identities_email_idx ON auth.identities USING btree (email text_pattern_ops);


--
-- Name: INDEX identities_email_idx; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON INDEX auth.identities_email_idx IS 'Auth: Ensures indexed queries on the email column';


--
-- Name: identities_user_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX identities_user_id_idx ON auth.identities USING btree (user_id);


--
-- Name: idx_auth_code; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX idx_auth_code ON auth.flow_state USING btree (auth_code);


--
-- Name: idx_oauth_client_states_created_at; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX idx_oauth_client_states_created_at ON auth.oauth_client_states USING btree (created_at);


--
-- Name: idx_user_id_auth_method; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX idx_user_id_auth_method ON auth.flow_state USING btree (user_id, authentication_method);


--
-- Name: mfa_challenge_created_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX mfa_challenge_created_at_idx ON auth.mfa_challenges USING btree (created_at DESC);


--
-- Name: mfa_factors_user_friendly_name_unique; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX mfa_factors_user_friendly_name_unique ON auth.mfa_factors USING btree (friendly_name, user_id) WHERE (TRIM(BOTH FROM friendly_name) <> ''::text);


--
-- Name: mfa_factors_user_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX mfa_factors_user_id_idx ON auth.mfa_factors USING btree (user_id);


--
-- Name: mfa_recovery_codes_set_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX mfa_recovery_codes_set_id_idx ON auth.mfa_recovery_codes USING btree (mfa_recovery_code_set_id);


--
-- Name: oauth_auth_pending_exp_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX oauth_auth_pending_exp_idx ON auth.oauth_authorizations USING btree (expires_at) WHERE (status = 'pending'::auth.oauth_authorization_status);


--
-- Name: oauth_clients_deleted_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX oauth_clients_deleted_at_idx ON auth.oauth_clients USING btree (deleted_at);


--
-- Name: oauth_consents_active_client_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX oauth_consents_active_client_idx ON auth.oauth_consents USING btree (client_id) WHERE (revoked_at IS NULL);


--
-- Name: oauth_consents_active_user_client_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX oauth_consents_active_user_client_idx ON auth.oauth_consents USING btree (user_id, client_id) WHERE (revoked_at IS NULL);


--
-- Name: oauth_consents_user_order_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX oauth_consents_user_order_idx ON auth.oauth_consents USING btree (user_id, granted_at DESC);


--
-- Name: one_time_tokens_relates_to_hash_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX one_time_tokens_relates_to_hash_idx ON auth.one_time_tokens USING hash (relates_to);


--
-- Name: one_time_tokens_token_hash_hash_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX one_time_tokens_token_hash_hash_idx ON auth.one_time_tokens USING hash (token_hash);


--
-- Name: one_time_tokens_user_id_token_type_key; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX one_time_tokens_user_id_token_type_key ON auth.one_time_tokens USING btree (user_id, token_type);


--
-- Name: reauthentication_token_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX reauthentication_token_idx ON auth.users USING btree (reauthentication_token) WHERE ((reauthentication_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: recovery_token_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX recovery_token_idx ON auth.users USING btree (recovery_token) WHERE ((recovery_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: refresh_tokens_instance_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX refresh_tokens_instance_id_idx ON auth.refresh_tokens USING btree (instance_id);


--
-- Name: refresh_tokens_instance_id_user_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX refresh_tokens_instance_id_user_id_idx ON auth.refresh_tokens USING btree (instance_id, user_id);


--
-- Name: refresh_tokens_parent_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX refresh_tokens_parent_idx ON auth.refresh_tokens USING btree (parent);


--
-- Name: refresh_tokens_session_id_revoked_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX refresh_tokens_session_id_revoked_idx ON auth.refresh_tokens USING btree (session_id, revoked);


--
-- Name: refresh_tokens_updated_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX refresh_tokens_updated_at_idx ON auth.refresh_tokens USING btree (updated_at DESC);


--
-- Name: saml_providers_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX saml_providers_sso_provider_id_idx ON auth.saml_providers USING btree (sso_provider_id);


--
-- Name: saml_relay_states_created_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX saml_relay_states_created_at_idx ON auth.saml_relay_states USING btree (created_at DESC);


--
-- Name: saml_relay_states_for_email_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX saml_relay_states_for_email_idx ON auth.saml_relay_states USING btree (for_email);


--
-- Name: saml_relay_states_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX saml_relay_states_sso_provider_id_idx ON auth.saml_relay_states USING btree (sso_provider_id);


--
-- Name: scim_tokens_expires_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX scim_tokens_expires_at_idx ON auth.scim_tokens USING btree (expires_at);


--
-- Name: scim_tokens_revoked_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX scim_tokens_revoked_at_idx ON auth.scim_tokens USING btree (revoked_at);


--
-- Name: scim_tokens_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX scim_tokens_sso_provider_id_idx ON auth.scim_tokens USING btree (sso_provider_id);


--
-- Name: scim_tokens_token_hash_key; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX scim_tokens_token_hash_key ON auth.scim_tokens USING btree (token_hash);


--
-- Name: scim_users_created_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX scim_users_created_at_idx ON auth.scim_users USING btree (sso_provider_id, created_at, id) WHERE (deleted_at IS NULL);


--
-- Name: scim_users_deleted_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX scim_users_deleted_at_idx ON auth.scim_users USING btree (deleted_at);


--
-- Name: scim_users_external_id_key; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX scim_users_external_id_key ON auth.scim_users USING btree (sso_provider_id, external_id) WHERE ((external_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: scim_users_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX scim_users_id_idx ON auth.scim_users USING btree (sso_provider_id, id) WHERE (deleted_at IS NULL);


--
-- Name: scim_users_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX scim_users_sso_provider_id_idx ON auth.scim_users USING btree (sso_provider_id);


--
-- Name: scim_users_updated_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX scim_users_updated_at_idx ON auth.scim_users USING btree (sso_provider_id, updated_at, id) WHERE (deleted_at IS NULL);


--
-- Name: scim_users_user_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX scim_users_user_id_idx ON auth.scim_users USING btree (user_id);


--
-- Name: scim_users_user_name_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX scim_users_user_name_idx ON auth.scim_users USING btree (sso_provider_id, user_name COLLATE "C", id) WHERE (deleted_at IS NULL);


--
-- Name: scim_users_user_name_key; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX scim_users_user_name_key ON auth.scim_users USING btree (sso_provider_id, user_name) WHERE (deleted_at IS NULL);


--
-- Name: sessions_not_after_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX sessions_not_after_idx ON auth.sessions USING btree (not_after DESC);


--
-- Name: sessions_oauth_client_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX sessions_oauth_client_id_idx ON auth.sessions USING btree (oauth_client_id);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX sessions_user_id_idx ON auth.sessions USING btree (user_id);


--
-- Name: sso_domains_domain_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX sso_domains_domain_idx ON auth.sso_domains USING btree (lower(domain));


--
-- Name: sso_domains_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX sso_domains_sso_provider_id_idx ON auth.sso_domains USING btree (sso_provider_id);


--
-- Name: sso_providers_resource_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX sso_providers_resource_id_idx ON auth.sso_providers USING btree (lower(resource_id));


--
-- Name: sso_providers_resource_id_pattern_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX sso_providers_resource_id_pattern_idx ON auth.sso_providers USING btree (resource_id text_pattern_ops);


--
-- Name: unique_phone_factor_per_user; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX unique_phone_factor_per_user ON auth.mfa_factors USING btree (user_id, phone);


--
-- Name: user_id_created_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX user_id_created_at_idx ON auth.sessions USING btree (user_id, created_at);


--
-- Name: users_email_partial_key; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX users_email_partial_key ON auth.users USING btree (email) WHERE (is_sso_user = false);


--
-- Name: INDEX users_email_partial_key; Type: COMMENT; Schema: auth; Owner: supabase_auth_admin
--

COMMENT ON INDEX auth.users_email_partial_key IS 'Auth: A partial unique index that applies only when is_sso_user is false';


--
-- Name: users_instance_id_email_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX users_instance_id_email_idx ON auth.users USING btree (instance_id, lower((email)::text));


--
-- Name: users_instance_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX users_instance_id_idx ON auth.users USING btree (instance_id);


--
-- Name: users_is_anonymous_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX users_is_anonymous_idx ON auth.users USING btree (is_anonymous);


--
-- Name: webauthn_challenges_expires_at_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX webauthn_challenges_expires_at_idx ON auth.webauthn_challenges USING btree (expires_at);


--
-- Name: webauthn_challenges_user_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX webauthn_challenges_user_id_idx ON auth.webauthn_challenges USING btree (user_id);


--
-- Name: webauthn_credentials_credential_id_key; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE UNIQUE INDEX webauthn_credentials_credential_id_key ON auth.webauthn_credentials USING btree (credential_id);


--
-- Name: webauthn_credentials_user_id_idx; Type: INDEX; Schema: auth; Owner: supabase_auth_admin
--

CREATE INDEX webauthn_credentials_user_id_idx ON auth.webauthn_credentials USING btree (user_id);


--
-- Name: idx_advance_contract_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_advance_contract_id ON public.contract_advance_schedule USING btree (contract_id);


--
-- Name: idx_bsm_contractor_rates_counterparty_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_bsm_contractor_rates_counterparty_id ON public.bsm_contractor_rates USING btree (counterparty_id);


--
-- Name: idx_bsm_contractor_rates_object_counterparty; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_bsm_contractor_rates_object_counterparty ON public.bsm_contractor_rates USING btree (object_id, counterparty_id);


--
-- Name: idx_bsm_contractor_rates_object_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_bsm_contractor_rates_object_id ON public.bsm_contractor_rates USING btree (object_id);


--
-- Name: idx_bsm_rates_object_material; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_bsm_rates_object_material ON public.bsm_supply_rates USING btree (object_id, lower(TRIM(BOTH FROM material_name)));


--
-- Name: idx_clause_comments_dispute_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_clause_comments_dispute_id ON public.contract_clause_comments USING btree (dispute_id);


--
-- Name: idx_clause_disputes_contract_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_clause_disputes_contract_id ON public.contract_clause_disputes USING btree (contract_id);


--
-- Name: idx_clause_disputes_counterparty_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_clause_disputes_counterparty_id ON public.contract_clause_disputes USING btree (counterparty_id);


--
-- Name: idx_client_errors_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_client_errors_at ON public.client_errors USING btree (at);


--
-- Name: idx_client_versions_last_seen; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_client_versions_last_seen ON public.client_versions USING btree (last_seen_at);


--
-- Name: idx_contacts_department_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contacts_department_id ON public.contacts USING btree (department_id);


--
-- Name: idx_contacts_full_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contacts_full_name ON public.contacts USING btree (full_name);


--
-- Name: idx_contacts_object_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contacts_object_id ON public.contacts USING btree (object_id);


--
-- Name: idx_contacts_position; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contacts_position ON public.contacts USING btree ("position");


--
-- Name: idx_contract_appendices_contract; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contract_appendices_contract ON public.contract_appendices USING btree (contract_id);


--
-- Name: idx_contract_appendices_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contract_appendices_parent ON public.contract_appendices USING btree (parent_id);


--
-- Name: idx_contract_attachments_attachment_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contract_attachments_attachment_id ON public.contract_attachments USING btree (attachment_id);


--
-- Name: idx_contract_attachments_contract_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contract_attachments_contract_id ON public.contract_attachments USING btree (contract_id);


--
-- Name: idx_contract_audit_log_changed_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contract_audit_log_changed_at ON public.contract_audit_log USING btree (changed_at DESC);


--
-- Name: idx_contract_audit_log_contract_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contract_audit_log_contract_id ON public.contract_audit_log USING btree (contract_id);


--
-- Name: idx_contract_clauses_contract_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contract_clauses_contract_id ON public.contract_clauses USING btree (contract_id);


--
-- Name: idx_contract_clauses_order; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contract_clauses_order ON public.contract_clauses USING btree (contract_id, order_index);


--
-- Name: idx_contract_counterparties_contract_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contract_counterparties_contract_id ON public.contract_counterparties USING btree (contract_id);


--
-- Name: idx_contract_counterparties_counterparty_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contract_counterparties_counterparty_id ON public.contract_counterparties USING btree (counterparty_id);


--
-- Name: idx_contract_counterparties_cp_contract; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contract_counterparties_cp_contract ON public.contract_counterparties USING btree (counterparty_id, contract_id);


--
-- Name: idx_contracts_contract_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_contract_date ON public.contracts USING btree (contract_date);


--
-- Name: idx_contracts_contract_number; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_contract_number ON public.contracts USING btree (contract_number);


--
-- Name: idx_contracts_counterparty_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_counterparty_id ON public.contracts USING btree (counterparty_id);


--
-- Name: idx_contracts_deleted_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_deleted_at ON public.contracts USING btree (deleted_at);


--
-- Name: idx_contracts_display_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_display_id ON public.contracts USING btree (display_id);


--
-- Name: idx_contracts_handled_by_us; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_handled_by_us ON public.contracts USING btree (handled_by_us) WHERE (deleted_at IS NULL);


--
-- Name: idx_contracts_object_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_object_id ON public.contracts USING btree (object_id);


--
-- Name: idx_contracts_parent_contract_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_parent_contract_id ON public.contracts USING btree (parent_contract_id);


--
-- Name: idx_contracts_record_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_record_status ON public.contracts USING btree (record_type, status);


--
-- Name: idx_contracts_record_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_record_type ON public.contracts USING btree (record_type);


--
-- Name: idx_contracts_responsible_contact_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_responsible_contact_id ON public.contracts USING btree (responsible_contact_id);


--
-- Name: idx_contracts_root_contract_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_root_contract_id ON public.contracts USING btree (root_contract_id);


--
-- Name: idx_contracts_root_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_root_type ON public.contracts USING btree (root_contract_id, record_type);


--
-- Name: idx_contracts_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_status ON public.contracts USING btree (status);


--
-- Name: idx_contracts_tender_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_tender_id ON public.contracts USING btree (tender_id);


--
-- Name: idx_contracts_work_dates; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_contracts_work_dates ON public.contracts USING btree (work_start_date, work_end_date);


--
-- Name: idx_counterparties_deleted_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_counterparties_deleted_at ON public.counterparties USING btree (deleted_at);


--
-- Name: idx_counterparties_inn; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_counterparties_inn ON public.counterparties USING btree (inn);


--
-- Name: idx_counterparties_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_counterparties_name ON public.counterparties USING btree (name);


--
-- Name: idx_counterparty_audit_log_changed_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_counterparty_audit_log_changed_at ON public.counterparty_audit_log USING btree (changed_at DESC);


--
-- Name: idx_counterparty_audit_log_counterparty_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_counterparty_audit_log_counterparty_id ON public.counterparty_audit_log USING btree (counterparty_id);


--
-- Name: idx_counterparty_contacts_counterparty_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_counterparty_contacts_counterparty_id ON public.counterparty_contacts USING btree (counterparty_id);


--
-- Name: idx_counterparty_contacts_full_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_counterparty_contacts_full_name ON public.counterparty_contacts USING btree (full_name);


--
-- Name: idx_counterparty_relations_cid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_counterparty_relations_cid ON public.counterparty_relations USING btree (counterparty_id);


--
-- Name: idx_counterparty_relations_rcid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_counterparty_relations_rcid ON public.counterparty_relations USING btree (related_counterparty_id);


--
-- Name: idx_dc_request_audit_log_changed_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dc_request_audit_log_changed_at ON public.dc_request_audit_log USING btree (changed_at DESC);


--
-- Name: idx_dc_request_audit_log_request_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dc_request_audit_log_request_id ON public.dc_request_audit_log USING btree (dc_request_id);


--
-- Name: idx_dc_request_tasks_request; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dc_request_tasks_request ON public.dc_request_tasks USING btree (request_id, order_number);


--
-- Name: idx_dc_requests_check_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dc_requests_check_status ON public.dc_requests USING btree (check_status, status) WHERE (deleted_at IS NULL);


--
-- Name: idx_dc_requests_counterparty; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dc_requests_counterparty ON public.dc_requests USING btree (counterparty_id);


--
-- Name: idx_dc_requests_deleted_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dc_requests_deleted_at ON public.dc_requests USING btree (deleted_at);


--
-- Name: idx_dc_requests_object; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dc_requests_object ON public.dc_requests USING btree (object_id);


--
-- Name: idx_dc_requests_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dc_requests_status ON public.dc_requests USING btree (status);


--
-- Name: idx_dcr_responsible; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dcr_responsible ON public.document_check_requests USING btree (responsible_contact_id);


--
-- Name: idx_departments_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_departments_name ON public.departments USING btree (name);


--
-- Name: idx_dispute_clauses_clause_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dispute_clauses_clause_id ON public.contract_clause_dispute_clauses USING btree (clause_id);


--
-- Name: idx_doc_check_audit_changed_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_doc_check_audit_changed_at ON public.doc_check_request_audit_log USING btree (changed_at DESC);


--
-- Name: idx_doc_check_audit_request; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_doc_check_audit_request ON public.doc_check_request_audit_log USING btree (request_id);


--
-- Name: idx_doc_check_requests_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_doc_check_requests_active ON public.doc_check_requests USING btree (status, sort_order) WHERE (deleted_at IS NULL);


--
-- Name: idx_doc_check_requests_counterparty; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_doc_check_requests_counterparty ON public.doc_check_requests USING btree (counterparty_id);


--
-- Name: idx_doc_check_requests_object; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_doc_check_requests_object ON public.doc_check_requests USING btree (object_id);


--
-- Name: idx_document_check_requests_counterparty; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_document_check_requests_counterparty ON public.document_check_requests USING btree (counterparty_id);


--
-- Name: idx_document_check_requests_object; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_document_check_requests_object ON public.document_check_requests USING btree (object_id);


--
-- Name: idx_document_check_requests_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_document_check_requests_status ON public.document_check_requests USING btree (status);


--
-- Name: idx_employees_full_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_employees_full_name ON public.employees USING btree (full_name);


--
-- Name: idx_employees_is_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_employees_is_active ON public.employees USING btree (is_active);


--
-- Name: idx_gd_folders_category_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_gd_folders_category_parent ON public.general_document_folders USING btree (category, parent_id, sort_order);


--
-- Name: idx_gd_folders_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_gd_folders_parent ON public.general_document_folders USING btree (parent_id);


--
-- Name: idx_general_document_links_doc; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_general_document_links_doc ON public.general_document_links USING btree (general_document_id);


--
-- Name: idx_general_documents_category; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_general_documents_category ON public.general_documents USING btree (category);


--
-- Name: idx_general_documents_category_folder; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_general_documents_category_folder ON public.general_documents USING btree (category, folder_id, sort_order);


--
-- Name: idx_general_documents_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_general_documents_created_at ON public.general_documents USING btree (created_at DESC);


--
-- Name: idx_general_documents_folder; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_general_documents_folder ON public.general_documents USING btree (folder_id);


--
-- Name: idx_general_documents_sort_order; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_general_documents_sort_order ON public.general_documents USING btree (sort_order);


--
-- Name: idx_general_documents_source_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_general_documents_source_type ON public.general_documents USING btree (source_type);


--
-- Name: idx_general_documents_title; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_general_documents_title ON public.general_documents USING btree (title);


--
-- Name: idx_kp_rates_mv_counterparty; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_kp_rates_mv_counterparty ON public.kp_rates_registry_mv USING btree (counterparty_id);


--
-- Name: idx_kp_rates_mv_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_kp_rates_mv_date ON public.kp_rates_registry_mv USING btree (proposal_date DESC NULLS LAST);


--
-- Name: idx_kp_rates_mv_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_kp_rates_mv_id ON public.kp_rates_registry_mv USING btree (id);


--
-- Name: idx_kp_rates_mv_name_trgm; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_kp_rates_mv_name_trgm ON public.kp_rates_registry_mv USING gin (item_name public.gin_trgm_ops);


--
-- Name: idx_kp_rates_mv_object; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_kp_rates_mv_object ON public.kp_rates_registry_mv USING btree (object_id);


--
-- Name: idx_kp_rates_mv_price; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_kp_rates_mv_price ON public.kp_rates_registry_mv USING btree (price);


--
-- Name: idx_kp_rates_mv_tender; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_kp_rates_mv_tender ON public.kp_rates_registry_mv USING btree (tender_id);


--
-- Name: idx_kp_rates_mv_type_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_kp_rates_mv_type_name ON public.kp_rates_registry_mv USING btree (item_type, item_name, id);


--
-- Name: idx_object_areas_object; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_object_areas_object ON public.object_areas USING btree (object_id);


--
-- Name: idx_object_areas_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_object_areas_parent ON public.object_areas USING btree (parent_area_id);


--
-- Name: idx_object_contract_attachments_object_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_object_contract_attachments_object_id ON public.object_contract_attachments USING btree (object_id);


--
-- Name: idx_object_contract_attachments_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_object_contract_attachments_parent ON public.object_contract_attachments USING btree (parent_id);


--
-- Name: idx_object_cost_plan_object_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_object_cost_plan_object_id ON public.object_cost_plan USING btree (object_id);


--
-- Name: idx_object_documents_editable_s3; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_object_documents_editable_s3 ON public.object_documents USING btree (editable_s3_document_id);


--
-- Name: idx_object_documents_object_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_object_documents_object_id ON public.object_documents USING btree (object_id);


--
-- Name: idx_object_documents_order; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_object_documents_order ON public.object_documents USING btree (object_id, order_number);


--
-- Name: idx_object_documents_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_object_documents_parent ON public.object_documents USING btree (parent_document_id);


--
-- Name: idx_object_documents_signed_s3; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_object_documents_signed_s3 ON public.object_documents USING btree (signed_s3_document_id);


--
-- Name: idx_object_documents_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_object_documents_type ON public.object_documents USING btree (document_type);


--
-- Name: idx_object_estimate_items_object_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_object_estimate_items_object_id ON public.object_estimate_items USING btree (object_id);


--
-- Name: idx_object_staff_contact; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_object_staff_contact ON public.object_staff USING btree (contact_id);


--
-- Name: idx_object_staff_object; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_object_staff_object ON public.object_staff USING btree (object_id, staff_role, sort_order);


--
-- Name: idx_objects_construction_manager; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_objects_construction_manager ON public.objects USING btree (construction_manager_contact_id);


--
-- Name: idx_objects_coordinates; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_objects_coordinates ON public.objects USING btree (latitude, longitude);


--
-- Name: idx_objects_economist; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_objects_economist ON public.objects USING btree (economist_contact_id);


--
-- Name: idx_objects_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_objects_name ON public.objects USING btree (name);


--
-- Name: idx_objects_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_objects_status ON public.objects USING btree (status);


--
-- Name: idx_owrp_retention_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_owrp_retention_id ON public.object_warranty_retention_payments USING btree (retention_id);


--
-- Name: idx_positions_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_positions_name ON public.positions USING btree (name);


--
-- Name: idx_psdc_batch; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_psdc_batch ON public.psdc USING btree (batch_id);


--
-- Name: idx_psdc_contract_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_psdc_contract_id ON public.contract_psdc_items USING btree (contract_id);


--
-- Name: idx_psdc_document_state; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_psdc_document_state ON public.psdc USING btree (document_id, state);


--
-- Name: idx_psdc_issues_psdc; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_psdc_issues_psdc ON public.psdc_issues USING btree (psdc_id, severity);


--
-- Name: idx_psdc_rows_parent_section; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_psdc_rows_parent_section ON public.psdc_rows USING btree (parent_section_id);


--
-- Name: idx_role_permissions_role; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_role_permissions_role ON public.role_permissions USING btree (role);


--
-- Name: idx_s3_documents_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_s3_documents_created_at ON public.s3_documents USING btree (created_at DESC);


--
-- Name: idx_s3_documents_owner; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_s3_documents_owner ON public.s3_documents USING btree (owner_type, owner_id);


--
-- Name: idx_supply_rates_mv_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_supply_rates_mv_date ON public.supply_rates_registry_mv USING btree (rate_date DESC NULLS LAST);


--
-- Name: idx_supply_rates_mv_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_supply_rates_mv_id ON public.supply_rates_registry_mv USING btree (id);


--
-- Name: idx_supply_rates_mv_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_supply_rates_mv_name ON public.supply_rates_registry_mv USING btree (item_name, id);


--
-- Name: idx_supply_rates_mv_name_trgm; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_supply_rates_mv_name_trgm ON public.supply_rates_registry_mv USING gin (item_name public.gin_trgm_ops);


--
-- Name: idx_supply_rates_mv_object; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_supply_rates_mv_object ON public.supply_rates_registry_mv USING btree (object_id);


--
-- Name: idx_supply_rates_mv_price; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_supply_rates_mv_price ON public.supply_rates_registry_mv USING btree (price);


--
-- Name: idx_supply_rates_mv_tender; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_supply_rates_mv_tender ON public.supply_rates_registry_mv USING btree (tender_id);


--
-- Name: idx_task_audit_log_changed_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_audit_log_changed_at ON public.task_audit_log USING btree (changed_at DESC);


--
-- Name: idx_task_audit_log_task_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_audit_log_task_id ON public.task_audit_log USING btree (task_id);


--
-- Name: idx_task_checklist_task_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_checklist_task_id ON public.task_checklist_items USING btree (task_id, sort_order);


--
-- Name: idx_task_comments_task_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_comments_task_id ON public.task_comments USING btree (task_id, created_at);


--
-- Name: idx_task_participants_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_participants_user ON public.task_participants USING btree (user_id);


--
-- Name: idx_task_participants_user_task; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_task_participants_user_task ON public.task_participants USING btree (user_id, task_id);


--
-- Name: idx_tasks_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_active ON public.tasks USING btree (status, sort_order) WHERE (deleted_at IS NULL);


--
-- Name: idx_tasks_assignee; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_assignee ON public.tasks USING btree (assignee_user_id, status);


--
-- Name: idx_tasks_assignee_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_assignee_user_id ON public.tasks USING btree (assignee_user_id);


--
-- Name: idx_tasks_contract_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_contract_id ON public.tasks USING btree (contract_id);


--
-- Name: idx_tasks_created_by_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_created_by_user_id ON public.tasks USING btree (created_by_user_id);


--
-- Name: idx_tasks_creator; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_creator ON public.tasks USING btree (created_by_user_id);


--
-- Name: idx_tasks_due_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_due_date ON public.tasks USING btree (due_date);


--
-- Name: idx_tasks_object_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_object_id ON public.tasks USING btree (object_id);


--
-- Name: idx_tasks_tender_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_tender_id ON public.tasks USING btree (tender_id);


--
-- Name: idx_tcp_counterparty_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tcp_counterparty_id ON public.tender_counterparty_proposals USING btree (counterparty_id);


--
-- Name: idx_tcp_estimate_item_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tcp_estimate_item_id ON public.tender_counterparty_proposals USING btree (estimate_item_id);


--
-- Name: idx_tcp_proposal_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tcp_proposal_date ON public.tender_counterparty_proposals USING btree (tender_id, counterparty_id, proposal_date DESC);


--
-- Name: idx_tcp_tender_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tcp_tender_id ON public.tender_counterparty_proposals USING btree (tender_id);


--
-- Name: idx_tcp_unit_price_materials; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tcp_unit_price_materials ON public.tender_counterparty_proposals USING btree (unit_price_materials);


--
-- Name: idx_tcp_unit_price_works; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tcp_unit_price_works ON public.tender_counterparty_proposals USING btree (unit_price_works);


--
-- Name: idx_tei_cost_name_trgm; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tei_cost_name_trgm ON public.tender_estimate_items USING gin (cost_name public.gin_trgm_ops);


--
-- Name: idx_tei_unit; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tei_unit ON public.tender_estimate_items USING btree (unit);


--
-- Name: idx_tender_audit_log_changed_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_audit_log_changed_at ON public.tender_audit_log USING btree (changed_at DESC);


--
-- Name: idx_tender_audit_log_tender_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_audit_log_tender_id ON public.tender_audit_log USING btree (tender_id);


--
-- Name: idx_tender_counterparties_counterparty_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_counterparties_counterparty_id ON public.tender_counterparties USING btree (counterparty_id);


--
-- Name: idx_tender_counterparties_cp_tender; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_counterparties_cp_tender ON public.tender_counterparties USING btree (counterparty_id, tender_id);


--
-- Name: idx_tender_counterparties_sort; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_counterparties_sort ON public.tender_counterparties USING btree (tender_id, sort_order);


--
-- Name: idx_tender_counterparties_tender_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_counterparties_tender_id ON public.tender_counterparties USING btree (tender_id);


--
-- Name: idx_tender_counterparty_proposals_counterparty_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_counterparty_proposals_counterparty_id ON public.tender_counterparty_proposals USING btree (counterparty_id);


--
-- Name: idx_tender_counterparty_proposals_estimate_item_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_counterparty_proposals_estimate_item_id ON public.tender_counterparty_proposals USING btree (estimate_item_id);


--
-- Name: idx_tender_counterparty_proposals_tender_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_counterparty_proposals_tender_id ON public.tender_counterparty_proposals USING btree (tender_id);


--
-- Name: idx_tender_doc_links_doc; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_doc_links_doc ON public.tender_doc_links USING btree (tender_doc_id);


--
-- Name: idx_tender_docs_sort; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_docs_sort ON public.tender_docs USING btree (tender_id, sort_order);


--
-- Name: idx_tender_docs_tender; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_docs_tender ON public.tender_docs USING btree (tender_id);


--
-- Name: idx_tender_documents_tender_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_documents_tender_id ON public.tender_documents USING btree (tender_id);


--
-- Name: idx_tender_estimate_items_estimate_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_estimate_items_estimate_name ON public.tender_estimate_items USING btree (tender_id, estimate_name);


--
-- Name: idx_tender_estimate_items_row_number; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_estimate_items_row_number ON public.tender_estimate_items USING btree (tender_id, row_number);


--
-- Name: idx_tender_estimate_items_tender_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_estimate_items_tender_id ON public.tender_estimate_items USING btree (tender_id);


--
-- Name: idx_tender_proposal_files_remarks_branch; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_proposal_files_remarks_branch ON public.tender_proposal_files USING btree (review_status, remarks_send_required, summary_added) WHERE (file_kind = 'commercial_proposal'::text);


--
-- Name: idx_tender_proposal_files_summary; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_proposal_files_summary ON public.tender_proposal_files USING btree (review_status, summary_added) WHERE (file_kind = 'commercial_proposal'::text);


--
-- Name: idx_tender_rd_codes_tender; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_rd_codes_tender ON public.tender_rd_codes USING btree (tender_id, sort_order);


--
-- Name: idx_tender_rd_document_codes_code; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_rd_document_codes_code ON public.tender_rd_document_codes USING btree (rd_code_id);


--
-- Name: idx_tender_vor_supply_rates_tender; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_vor_supply_rates_tender ON public.tender_vor_supply_rates USING btree (tender_id);


--
-- Name: idx_tender_winners_counterparty_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_winners_counterparty_id ON public.tender_winners USING btree (counterparty_id);


--
-- Name: idx_tender_winners_tender_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tender_winners_tender_id ON public.tender_winners USING btree (tender_id);


--
-- Name: idx_tenders_cost_plan_responsible_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_cost_plan_responsible_id ON public.tenders USING btree (cost_plan_responsible_id);


--
-- Name: idx_tenders_cost_plan_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_cost_plan_status ON public.tenders USING btree (cost_plan_status);


--
-- Name: idx_tenders_custom_object_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_custom_object_name ON public.tenders USING btree (custom_object_name) WHERE (custom_object_name IS NOT NULL);


--
-- Name: idx_tenders_deleted_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_deleted_at ON public.tenders USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);


--
-- Name: idx_tenders_department; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_department ON public.tenders USING btree (department);


--
-- Name: idx_tenders_department_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_department_type ON public.tenders USING btree (department, tender_type);


--
-- Name: idx_tenders_end_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_end_date ON public.tenders USING btree (end_date);


--
-- Name: idx_tenders_object_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_object_id ON public.tenders USING btree (object_id);


--
-- Name: idx_tenders_parent_tender_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_parent_tender_id ON public.tenders USING btree (parent_tender_id);


--
-- Name: idx_tenders_public_tender_number; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_tenders_public_tender_number ON public.tenders USING btree (public_tender_number);


--
-- Name: idx_tenders_responsible_contact_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_responsible_contact_id ON public.tenders USING btree (responsible_contact_id);


--
-- Name: idx_tenders_responsible_employee_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_responsible_employee_id ON public.tenders USING btree (responsible_employee_id);


--
-- Name: idx_tenders_start_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_start_date ON public.tenders USING btree (start_date);


--
-- Name: idx_tenders_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_status ON public.tenders USING btree (status);


--
-- Name: idx_tenders_tender_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_tender_type ON public.tenders USING btree (tender_type);


--
-- Name: idx_tenders_vor_division; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_vor_division ON public.tenders USING btree (vor_division);


--
-- Name: idx_tenders_vor_responsible_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_vor_responsible_id ON public.tenders USING btree (vor_responsible_id);


--
-- Name: idx_tenders_vor_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_vor_status ON public.tenders USING btree (vor_status);


--
-- Name: idx_tenders_vor_sto_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_vor_sto_user ON public.tenders USING btree (vor_sto_user_id);


--
-- Name: idx_tenders_winner_counterparty_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tenders_winner_counterparty_id ON public.tenders USING btree (winner_counterparty_id);


--
-- Name: idx_tpf_proposal_group; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tpf_proposal_group ON public.tender_proposal_files USING btree (proposal_group_id) WHERE (proposal_group_id IS NOT NULL);


--
-- Name: idx_tpf_review_queue; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tpf_review_queue ON public.tender_proposal_files USING btree (review_status) WHERE ((file_kind = 'commercial_proposal'::text) AND review_required);


--
-- Name: idx_tpf_review_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tpf_review_status ON public.tender_proposal_files USING btree (review_status) WHERE (file_kind = 'commercial_proposal'::text);


--
-- Name: idx_tpf_reviewed_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tpf_reviewed_at ON public.tender_proposal_files USING btree (reviewed_at) WHERE (file_kind = 'commercial_proposal'::text);


--
-- Name: idx_tpf_s3_document; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tpf_s3_document ON public.tender_proposal_files USING btree (s3_document_id);


--
-- Name: idx_tpf_tender_counterparty; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tpf_tender_counterparty ON public.tender_proposal_files USING btree (tender_id, counterparty_id);


--
-- Name: idx_tvsr_material_name_trgm; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tvsr_material_name_trgm ON public.tender_vor_supply_rates USING gin (material_name public.gin_trgm_ops);


--
-- Name: idx_tvsr_tender_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tvsr_tender_id ON public.tender_vor_supply_rates USING btree (tender_id);


--
-- Name: idx_tvsr_unit; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tvsr_unit ON public.tender_vor_supply_rates USING btree (unit);


--
-- Name: idx_tvsr_updated_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tvsr_updated_at ON public.tender_vor_supply_rates USING btree (updated_at DESC);


--
-- Name: idx_user_roles_counterparty_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_user_roles_counterparty_id ON public.user_roles USING btree (counterparty_id);


--
-- Name: idx_user_roles_object_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_user_roles_object_id ON public.user_roles USING btree (object_id);


--
-- Name: idx_user_roles_object_ids; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_user_roles_object_ids ON public.user_roles USING gin (object_ids);


--
-- Name: idx_user_roles_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_user_roles_user_id ON public.user_roles USING btree (user_id);


--
-- Name: idx_vor_requests_deleted_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_vor_requests_deleted_at ON public.vor_requests USING btree (deleted_at);


--
-- Name: idx_vor_requests_department; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_vor_requests_department ON public.vor_requests USING btree (department);


--
-- Name: idx_vor_requests_object_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_vor_requests_object_id ON public.vor_requests USING btree (object_id);


--
-- Name: idx_work_types_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_work_types_name ON public.work_types USING btree (name);


--
-- Name: uq_contracts_amendment_number; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_contracts_amendment_number ON public.contracts USING btree (root_contract_id, btrim((contract_number)::text)) WHERE ((record_type <> 'dp'::text) AND (deleted_at IS NULL) AND (contract_number IS NOT NULL) AND (btrim((contract_number)::text) <> ''::text));


--
-- Name: uq_gd_folders_name_in_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_gd_folders_name_in_parent ON public.general_document_folders USING btree (parent_id, lower(btrim(name))) WHERE (parent_id IS NOT NULL);


--
-- Name: uq_gd_folders_name_in_root; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_gd_folders_name_in_root ON public.general_document_folders USING btree (category, lower(btrim(name))) WHERE (parent_id IS NULL);


--
-- Name: uq_psdc_base_row; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_psdc_base_row ON public.contract_psdc_items USING btree (contract_id, row_number) WHERE (agreement_id IS NULL);


--
-- Name: uq_psdc_one_applied_per_document; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_psdc_one_applied_per_document ON public.psdc USING btree (document_id) WHERE (state = 'applied'::text);


--
-- Name: uq_psdc_rows_logical; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_psdc_rows_logical ON public.psdc_rows USING btree (psdc_id, logical_line_id);


--
-- Name: uq_psdc_rows_order; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_psdc_rows_order ON public.psdc_rows USING btree (psdc_id, row_order);


--
-- Name: uq_tender_docs_final; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_tender_docs_final ON public.tender_docs USING btree (tender_id) WHERE is_final;


--
-- Name: contract_clause_disputes trg_clause_disputes_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_clause_disputes_updated_at BEFORE UPDATE ON public.contract_clause_disputes FOR EACH ROW EXECUTE FUNCTION public.update_clause_disputes_updated_at();


--
-- Name: contract_clauses trg_contract_clauses_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_contract_clauses_updated_at BEFORE UPDATE ON public.contract_clauses FOR EACH ROW EXECUTE FUNCTION public.update_contract_clauses_updated_at();


--
-- Name: contracts trg_contracts_delete_guard; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_contracts_delete_guard BEFORE DELETE OR UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.contracts_delete_guard();


--
-- Name: contracts trg_contracts_hierarchy_guard; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_contracts_hierarchy_guard BEFORE INSERT OR UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.contracts_hierarchy_guard();


--
-- Name: contracts trg_contracts_psdc_total_guard; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_contracts_psdc_total_guard BEFORE INSERT OR UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.contracts_psdc_total_guard();


--
-- Name: doc_check_requests trg_doc_check_requests_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_doc_check_requests_updated_at BEFORE UPDATE ON public.doc_check_requests FOR EACH ROW EXECUTE FUNCTION public.update_doc_check_requests_updated_at();


--
-- Name: general_document_folders trg_general_document_folders_validate; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_general_document_folders_validate BEFORE INSERT OR UPDATE ON public.general_document_folders FOR EACH ROW EXECUTE FUNCTION public.general_document_folders_validate();


--
-- Name: general_documents trg_general_documents_sync_folder_category; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_general_documents_sync_folder_category BEFORE INSERT OR UPDATE ON public.general_documents FOR EACH ROW EXECUTE FUNCTION public.general_documents_sync_folder_category();


--
-- Name: contract_clause_disputes trg_protect_dispute_columns; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_protect_dispute_columns BEFORE UPDATE ON public.contract_clause_disputes FOR EACH ROW EXECUTE FUNCTION public.protect_dispute_columns();


--
-- Name: objects trg_sync_tenders_department; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_sync_tenders_department AFTER UPDATE OF status ON public.objects FOR EACH ROW EXECUTE FUNCTION public.sync_tenders_department_from_object();


--
-- Name: tasks trg_tasks_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_tasks_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.update_tasks_updated_at();


--
-- Name: vor_requests trg_vor_requests_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_vor_requests_updated_at BEFORE UPDATE ON public.vor_requests FOR EACH ROW EXECUTE FUNCTION public.vor_requests_touch_updated_at();


--
-- Name: bsm_contract_rates trigger_bsm_contract_rates_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_bsm_contract_rates_updated_at BEFORE UPDATE ON public.bsm_contract_rates FOR EACH ROW EXECUTE FUNCTION public.update_bsm_contract_rates_updated_at();


--
-- Name: bsm_contractor_rates trigger_bsm_contractor_rates_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_bsm_contractor_rates_updated_at BEFORE UPDATE ON public.bsm_contractor_rates FOR EACH ROW EXECUTE FUNCTION public.update_bsm_contractor_rates_updated_at();


--
-- Name: bsm_supply_rates trigger_bsm_supply_rates_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_bsm_supply_rates_updated_at BEFORE UPDATE ON public.bsm_supply_rates FOR EACH ROW EXECUTE FUNCTION public.update_bsm_supply_rates_updated_at();


--
-- Name: employees trigger_employees_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_employees_updated_at BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION public.update_employees_updated_at();


--
-- Name: tender_vor_supply_rates trigger_tender_vor_supply_rates_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_tender_vor_supply_rates_updated_at BEFORE UPDATE ON public.tender_vor_supply_rates FOR EACH ROW EXECUTE FUNCTION public.update_tender_vor_supply_rates_updated_at();


--
-- Name: contacts trigger_update_contacts_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_update_contacts_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.update_contacts_updated_at();


--
-- Name: contract_advance_schedule trigger_update_contract_advance_schedule_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_update_contract_advance_schedule_updated_at BEFORE UPDATE ON public.contract_advance_schedule FOR EACH ROW EXECUTE FUNCTION public.update_contract_advance_schedule_updated_at();


--
-- Name: contract_psdc_items trigger_update_contract_psdc_items_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_update_contract_psdc_items_updated_at BEFORE UPDATE ON public.contract_psdc_items FOR EACH ROW EXECUTE FUNCTION public.update_contract_psdc_items_updated_at();


--
-- Name: contracts trigger_update_contracts_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_update_contracts_updated_at BEFORE UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.update_contracts_updated_at();


--
-- Name: counterparties trigger_update_counterparties_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_update_counterparties_updated_at BEFORE UPDATE ON public.counterparties FOR EACH ROW EXECUTE FUNCTION public.update_counterparties_updated_at();


--
-- Name: counterparty_contacts trigger_update_counterparty_contacts_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_update_counterparty_contacts_updated_at BEFORE UPDATE ON public.counterparty_contacts FOR EACH ROW EXECUTE FUNCTION public.update_counterparty_contacts_updated_at();


--
-- Name: object_cost_plan trigger_update_object_cost_plan_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_update_object_cost_plan_updated_at BEFORE UPDATE ON public.object_cost_plan FOR EACH ROW EXECUTE FUNCTION public.update_object_cost_plan_updated_at();


--
-- Name: object_documents trigger_update_object_documents_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_update_object_documents_updated_at BEFORE UPDATE ON public.object_documents FOR EACH ROW EXECUTE FUNCTION public.update_object_documents_updated_at();


--
-- Name: object_estimate_items trigger_update_object_estimate_items_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_update_object_estimate_items_updated_at BEFORE UPDATE ON public.object_estimate_items FOR EACH ROW EXECUTE FUNCTION public.update_object_estimate_items_updated_at();


--
-- Name: objects trigger_update_objects_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_update_objects_updated_at BEFORE UPDATE ON public.objects FOR EACH ROW EXECUTE FUNCTION public.update_objects_updated_at();


--
-- Name: tender_counterparty_proposals trigger_update_tender_counterparty_proposals_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_update_tender_counterparty_proposals_updated_at BEFORE UPDATE ON public.tender_counterparty_proposals FOR EACH ROW EXECUTE FUNCTION public.update_tender_counterparty_proposals_updated_at();


--
-- Name: tender_estimate_items trigger_update_tender_estimate_items_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_update_tender_estimate_items_updated_at BEFORE UPDATE ON public.tender_estimate_items FOR EACH ROW EXECUTE FUNCTION public.update_tender_estimate_items_updated_at();


--
-- Name: tenders trigger_update_tenders_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_update_tenders_updated_at BEFORE UPDATE ON public.tenders FOR EACH ROW EXECUTE FUNCTION public.update_tenders_updated_at();


--
-- Name: objects update_objects_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON public.objects FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: identities identities_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: mfa_amr_claims mfa_amr_claims_session_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT mfa_amr_claims_session_id_fkey FOREIGN KEY (session_id) REFERENCES auth.sessions(id) ON DELETE CASCADE;


--
-- Name: mfa_challenges mfa_challenges_auth_factor_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_challenges
    ADD CONSTRAINT mfa_challenges_auth_factor_id_fkey FOREIGN KEY (factor_id) REFERENCES auth.mfa_factors(id) ON DELETE CASCADE;


--
-- Name: mfa_factors mfa_factors_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: mfa_recovery_code_sets mfa_recovery_code_sets_mfa_factor_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_recovery_code_sets
    ADD CONSTRAINT mfa_recovery_code_sets_mfa_factor_id_fkey FOREIGN KEY (mfa_factor_id) REFERENCES auth.mfa_factors(id) ON DELETE CASCADE;


--
-- Name: mfa_recovery_code_sets mfa_recovery_code_sets_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_recovery_code_sets
    ADD CONSTRAINT mfa_recovery_code_sets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: mfa_recovery_codes mfa_recovery_codes_mfa_recovery_code_set_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.mfa_recovery_codes
    ADD CONSTRAINT mfa_recovery_codes_mfa_recovery_code_set_id_fkey FOREIGN KEY (mfa_recovery_code_set_id) REFERENCES auth.mfa_recovery_code_sets(id) ON DELETE CASCADE;


--
-- Name: oauth_authorizations oauth_authorizations_client_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON DELETE CASCADE;


--
-- Name: oauth_authorizations oauth_authorizations_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: oauth_consents oauth_consents_client_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_consents
    ADD CONSTRAINT oauth_consents_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON DELETE CASCADE;


--
-- Name: oauth_consents oauth_consents_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.oauth_consents
    ADD CONSTRAINT oauth_consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: one_time_tokens one_time_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.one_time_tokens
    ADD CONSTRAINT one_time_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_session_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES auth.sessions(id) ON DELETE CASCADE;


--
-- Name: saml_providers saml_providers_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: saml_relay_states saml_relay_states_flow_state_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_flow_state_id_fkey FOREIGN KEY (flow_state_id) REFERENCES auth.flow_state(id) ON DELETE CASCADE;


--
-- Name: saml_relay_states saml_relay_states_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: scim_tokens scim_tokens_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.scim_tokens
    ADD CONSTRAINT scim_tokens_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: scim_users scim_users_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.scim_users
    ADD CONSTRAINT scim_users_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: scim_users scim_users_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.scim_users
    ADD CONSTRAINT scim_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_oauth_client_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_oauth_client_id_fkey FOREIGN KEY (oauth_client_id) REFERENCES auth.oauth_clients(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: sso_domains sso_domains_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.sso_domains
    ADD CONSTRAINT sso_domains_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: webauthn_challenges webauthn_challenges_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: webauthn_credentials webauthn_credentials_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE ONLY auth.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: bsm_supply_rates bsm_approved_rates_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bsm_supply_rates
    ADD CONSTRAINT bsm_approved_rates_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: bsm_contract_rates bsm_contract_rates_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bsm_contract_rates
    ADD CONSTRAINT bsm_contract_rates_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: bsm_contractor_rates bsm_contractor_rates_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bsm_contractor_rates
    ADD CONSTRAINT bsm_contractor_rates_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE CASCADE;


--
-- Name: bsm_contractor_rates bsm_contractor_rates_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bsm_contractor_rates
    ADD CONSTRAINT bsm_contractor_rates_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: contract_advance_schedule contract_advance_schedule_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_advance_schedule
    ADD CONSTRAINT contract_advance_schedule_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contract_appendices contract_appendices_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_appendices
    ADD CONSTRAINT contract_appendices_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contract_appendices contract_appendices_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_appendices
    ADD CONSTRAINT contract_appendices_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.contract_appendices(id) ON DELETE CASCADE;


--
-- Name: contract_attachments contract_attachments_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_attachments
    ADD CONSTRAINT contract_attachments_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.object_contract_attachments(id) ON DELETE CASCADE;


--
-- Name: contract_attachments contract_attachments_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_attachments
    ADD CONSTRAINT contract_attachments_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contract_audit_log contract_audit_log_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_audit_log
    ADD CONSTRAINT contract_audit_log_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contract_clause_comments contract_clause_comments_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_clause_comments
    ADD CONSTRAINT contract_clause_comments_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE CASCADE;


--
-- Name: contract_clause_comments contract_clause_comments_dispute_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_clause_comments
    ADD CONSTRAINT contract_clause_comments_dispute_id_fkey FOREIGN KEY (dispute_id) REFERENCES public.contract_clause_disputes(id) ON DELETE CASCADE;


--
-- Name: contract_clause_dispute_clauses contract_clause_dispute_clauses_clause_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_clause_dispute_clauses
    ADD CONSTRAINT contract_clause_dispute_clauses_clause_id_fkey FOREIGN KEY (clause_id) REFERENCES public.contract_clauses(id) ON DELETE CASCADE;


--
-- Name: contract_clause_dispute_clauses contract_clause_dispute_clauses_dispute_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_clause_dispute_clauses
    ADD CONSTRAINT contract_clause_dispute_clauses_dispute_id_fkey FOREIGN KEY (dispute_id) REFERENCES public.contract_clause_disputes(id) ON DELETE CASCADE;


--
-- Name: contract_clause_disputes contract_clause_disputes_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_clause_disputes
    ADD CONSTRAINT contract_clause_disputes_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contract_clause_disputes contract_clause_disputes_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_clause_disputes
    ADD CONSTRAINT contract_clause_disputes_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE CASCADE;


--
-- Name: contract_clauses contract_clauses_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_clauses
    ADD CONSTRAINT contract_clauses_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contract_counterparties contract_counterparties_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_counterparties
    ADD CONSTRAINT contract_counterparties_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contract_counterparties contract_counterparties_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_counterparties
    ADD CONSTRAINT contract_counterparties_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE CASCADE;


--
-- Name: contract_psdc_items contract_psdc_items_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contract_psdc_items
    ADD CONSTRAINT contract_psdc_items_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contracts contracts_concept_agreement_s3_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_concept_agreement_s3_document_id_fkey FOREIGN KEY (concept_agreement_s3_document_id) REFERENCES public.s3_documents(id) ON DELETE SET NULL;


--
-- Name: contracts contracts_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE SET NULL;


--
-- Name: contracts contracts_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: contracts contracts_parent_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_parent_contract_id_fkey FOREIGN KEY (parent_contract_id) REFERENCES public.contracts(id) ON DELETE SET NULL;


--
-- Name: contracts contracts_psdc_applied_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_psdc_applied_id_fkey FOREIGN KEY (psdc_applied_id) REFERENCES public.psdc(id) ON DELETE SET NULL;


--
-- Name: contracts contracts_responsible_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_responsible_contact_id_fkey FOREIGN KEY (responsible_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: contracts contracts_root_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_root_contract_id_fkey FOREIGN KEY (root_contract_id) REFERENCES public.contracts(id) ON DELETE SET NULL;


--
-- Name: contracts contracts_tender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_tender_id_fkey FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE SET NULL;


--
-- Name: counterparty_audit_log counterparty_audit_log_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.counterparty_audit_log
    ADD CONSTRAINT counterparty_audit_log_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE CASCADE;


--
-- Name: counterparty_contacts counterparty_contacts_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.counterparty_contacts
    ADD CONSTRAINT counterparty_contacts_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE CASCADE;


--
-- Name: counterparty_relations counterparty_relations_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.counterparty_relations
    ADD CONSTRAINT counterparty_relations_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE CASCADE;


--
-- Name: counterparty_relations counterparty_relations_related_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.counterparty_relations
    ADD CONSTRAINT counterparty_relations_related_counterparty_id_fkey FOREIGN KEY (related_counterparty_id) REFERENCES public.counterparties(id) ON DELETE CASCADE;


--
-- Name: dc_request_audit_log dc_request_audit_log_dc_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dc_request_audit_log
    ADD CONSTRAINT dc_request_audit_log_dc_request_id_fkey FOREIGN KEY (dc_request_id) REFERENCES public.dc_requests(id) ON DELETE CASCADE;


--
-- Name: dc_request_tasks dc_request_tasks_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dc_request_tasks
    ADD CONSTRAINT dc_request_tasks_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.dc_requests(id) ON DELETE CASCADE;


--
-- Name: dc_requests dc_requests_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dc_requests
    ADD CONSTRAINT dc_requests_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE SET NULL;


--
-- Name: dc_requests dc_requests_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dc_requests
    ADD CONSTRAINT dc_requests_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: dc_requests dc_requests_responsible_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dc_requests
    ADD CONSTRAINT dc_requests_responsible_contact_id_fkey FOREIGN KEY (responsible_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: doc_check_request_audit_log doc_check_request_audit_log_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.doc_check_request_audit_log
    ADD CONSTRAINT doc_check_request_audit_log_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.doc_check_requests(id) ON DELETE CASCADE;


--
-- Name: doc_check_requests doc_check_requests_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.doc_check_requests
    ADD CONSTRAINT doc_check_requests_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE SET NULL;


--
-- Name: doc_check_requests doc_check_requests_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.doc_check_requests
    ADD CONSTRAINT doc_check_requests_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: document_check_requests document_check_requests_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.document_check_requests
    ADD CONSTRAINT document_check_requests_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE SET NULL;


--
-- Name: document_check_requests document_check_requests_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.document_check_requests
    ADD CONSTRAINT document_check_requests_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: document_check_requests document_check_requests_responsible_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.document_check_requests
    ADD CONSTRAINT document_check_requests_responsible_contact_id_fkey FOREIGN KEY (responsible_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: general_document_folders general_document_folders_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.general_document_folders
    ADD CONSTRAINT general_document_folders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.general_document_folders(id) ON DELETE RESTRICT;


--
-- Name: general_document_links general_document_links_general_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.general_document_links
    ADD CONSTRAINT general_document_links_general_document_id_fkey FOREIGN KEY (general_document_id) REFERENCES public.general_documents(id) ON DELETE CASCADE;


--
-- Name: general_documents general_documents_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.general_documents
    ADD CONSTRAINT general_documents_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.general_document_folders(id) ON DELETE RESTRICT;


--
-- Name: general_documents general_documents_s3_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.general_documents
    ADD CONSTRAINT general_documents_s3_document_id_fkey FOREIGN KEY (s3_document_id) REFERENCES public.s3_documents(id) ON DELETE SET NULL;


--
-- Name: object_areas object_areas_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_areas
    ADD CONSTRAINT object_areas_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: object_areas object_areas_parent_area_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_areas
    ADD CONSTRAINT object_areas_parent_area_id_fkey FOREIGN KEY (parent_area_id) REFERENCES public.object_areas(id) ON DELETE CASCADE;


--
-- Name: object_contract_attachments object_contract_attachments_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_contract_attachments
    ADD CONSTRAINT object_contract_attachments_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: object_contract_attachments object_contract_attachments_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_contract_attachments
    ADD CONSTRAINT object_contract_attachments_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.object_contract_attachments(id) ON DELETE CASCADE;


--
-- Name: object_cost_plan object_cost_plan_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_cost_plan
    ADD CONSTRAINT object_cost_plan_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: object_documents object_documents_editable_s3_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_documents
    ADD CONSTRAINT object_documents_editable_s3_document_id_fkey FOREIGN KEY (editable_s3_document_id) REFERENCES public.s3_documents(id) ON DELETE SET NULL;


--
-- Name: object_documents object_documents_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_documents
    ADD CONSTRAINT object_documents_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: object_documents object_documents_parent_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_documents
    ADD CONSTRAINT object_documents_parent_document_id_fkey FOREIGN KEY (parent_document_id) REFERENCES public.object_documents(id) ON DELETE CASCADE;


--
-- Name: object_documents object_documents_signed_s3_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_documents
    ADD CONSTRAINT object_documents_signed_s3_document_id_fkey FOREIGN KEY (signed_s3_document_id) REFERENCES public.s3_documents(id) ON DELETE SET NULL;


--
-- Name: object_estimate_items object_estimate_items_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_estimate_items
    ADD CONSTRAINT object_estimate_items_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: object_staff object_staff_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_staff
    ADD CONSTRAINT object_staff_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: object_staff object_staff_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_staff
    ADD CONSTRAINT object_staff_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: object_warranties object_warranties_actual_start_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_warranties
    ADD CONSTRAINT object_warranties_actual_start_document_id_fkey FOREIGN KEY (actual_start_document_id) REFERENCES public.s3_documents(id) ON DELETE SET NULL;


--
-- Name: object_warranties object_warranties_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_warranties
    ADD CONSTRAINT object_warranties_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: object_warranties object_warranties_start_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_warranties
    ADD CONSTRAINT object_warranties_start_document_id_fkey FOREIGN KEY (start_document_id) REFERENCES public.object_documents(id) ON DELETE SET NULL;


--
-- Name: object_warranty_retention_payments object_warranty_retention_payments_retention_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_warranty_retention_payments
    ADD CONSTRAINT object_warranty_retention_payments_retention_id_fkey FOREIGN KEY (retention_id) REFERENCES public.object_warranty_retentions(id) ON DELETE CASCADE;


--
-- Name: object_warranty_retentions object_warranty_retentions_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.object_warranty_retentions
    ADD CONSTRAINT object_warranty_retentions_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE CASCADE;


--
-- Name: objects objects_construction_manager_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_construction_manager_contact_id_fkey FOREIGN KEY (construction_manager_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: objects objects_economist_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_economist_contact_id_fkey FOREIGN KEY (economist_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: psdc psdc_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.psdc
    ADD CONSTRAINT psdc_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.psdc_batches(id) ON DELETE SET NULL;


--
-- Name: psdc psdc_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.psdc
    ADD CONSTRAINT psdc_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: psdc_issues psdc_issues_psdc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.psdc_issues
    ADD CONSTRAINT psdc_issues_psdc_id_fkey FOREIGN KEY (psdc_id) REFERENCES public.psdc(id) ON DELETE CASCADE;


--
-- Name: psdc psdc_previous_psdc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.psdc
    ADD CONSTRAINT psdc_previous_psdc_id_fkey FOREIGN KEY (previous_psdc_id) REFERENCES public.psdc(id) ON DELETE SET NULL;


--
-- Name: psdc_rows psdc_rows_parent_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.psdc_rows
    ADD CONSTRAINT psdc_rows_parent_section_id_fkey FOREIGN KEY (parent_section_id) REFERENCES public.psdc_rows(id) ON DELETE SET NULL;


--
-- Name: psdc_rows psdc_rows_psdc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.psdc_rows
    ADD CONSTRAINT psdc_rows_psdc_id_fkey FOREIGN KEY (psdc_id) REFERENCES public.psdc(id) ON DELETE CASCADE;


--
-- Name: psdc_source_rows psdc_source_rows_psdc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.psdc_source_rows
    ADD CONSTRAINT psdc_source_rows_psdc_id_fkey FOREIGN KEY (psdc_id) REFERENCES public.psdc(id) ON DELETE CASCADE;


--
-- Name: psdc psdc_source_s3_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.psdc
    ADD CONSTRAINT psdc_source_s3_document_id_fkey FOREIGN KEY (source_s3_document_id) REFERENCES public.s3_documents(id) ON DELETE SET NULL;


--
-- Name: task_audit_log task_audit_log_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_audit_log
    ADD CONSTRAINT task_audit_log_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_checklist_items task_checklist_items_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_checklist_items
    ADD CONSTRAINT task_checklist_items_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_comments task_comments_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_participants task_participants_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.task_participants
    ADD CONSTRAINT task_participants_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_tender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_tender_id_fkey FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE SET NULL;


--
-- Name: tender_audit_log tender_audit_log_tender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_audit_log
    ADD CONSTRAINT tender_audit_log_tender_id_fkey FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE CASCADE;


--
-- Name: tender_counterparties tender_counterparties_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_counterparties
    ADD CONSTRAINT tender_counterparties_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE CASCADE;


--
-- Name: tender_counterparties tender_counterparties_tender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_counterparties
    ADD CONSTRAINT tender_counterparties_tender_id_fkey FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE CASCADE;


--
-- Name: tender_counterparty_proposals tender_counterparty_proposals_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_counterparty_proposals
    ADD CONSTRAINT tender_counterparty_proposals_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE CASCADE;


--
-- Name: tender_counterparty_proposals tender_counterparty_proposals_estimate_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_counterparty_proposals
    ADD CONSTRAINT tender_counterparty_proposals_estimate_item_id_fkey FOREIGN KEY (estimate_item_id) REFERENCES public.tender_estimate_items(id) ON DELETE CASCADE;


--
-- Name: tender_counterparty_proposals tender_counterparty_proposals_tender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_counterparty_proposals
    ADD CONSTRAINT tender_counterparty_proposals_tender_id_fkey FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE CASCADE;


--
-- Name: tender_doc_links tender_doc_links_tender_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_doc_links
    ADD CONSTRAINT tender_doc_links_tender_doc_id_fkey FOREIGN KEY (tender_doc_id) REFERENCES public.tender_docs(id) ON DELETE CASCADE;


--
-- Name: tender_docs tender_docs_tender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_docs
    ADD CONSTRAINT tender_docs_tender_id_fkey FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE CASCADE;


--
-- Name: tender_documents tender_documents_tender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_documents
    ADD CONSTRAINT tender_documents_tender_id_fkey FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE CASCADE;


--
-- Name: tender_estimate_items tender_estimate_items_tender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_estimate_items
    ADD CONSTRAINT tender_estimate_items_tender_id_fkey FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE CASCADE;


--
-- Name: tender_proposal_files tender_proposal_files_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_proposal_files
    ADD CONSTRAINT tender_proposal_files_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE CASCADE;


--
-- Name: tender_proposal_files tender_proposal_files_review_note_s3_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_proposal_files
    ADD CONSTRAINT tender_proposal_files_review_note_s3_document_id_fkey FOREIGN KEY (review_note_s3_document_id) REFERENCES public.s3_documents(id) ON DELETE SET NULL;


--
-- Name: tender_proposal_files tender_proposal_files_s3_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_proposal_files
    ADD CONSTRAINT tender_proposal_files_s3_document_id_fkey FOREIGN KEY (s3_document_id) REFERENCES public.s3_documents(id) ON DELETE CASCADE;


--
-- Name: tender_proposal_files tender_proposal_files_tender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_proposal_files
    ADD CONSTRAINT tender_proposal_files_tender_id_fkey FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE CASCADE;


--
-- Name: tender_rd_codes tender_rd_codes_tender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_rd_codes
    ADD CONSTRAINT tender_rd_codes_tender_id_fkey FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE CASCADE;


--
-- Name: tender_rd_document_codes tender_rd_document_codes_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_rd_document_codes
    ADD CONSTRAINT tender_rd_document_codes_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.s3_documents(id) ON DELETE CASCADE;


--
-- Name: tender_rd_document_codes tender_rd_document_codes_rd_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_rd_document_codes
    ADD CONSTRAINT tender_rd_document_codes_rd_code_id_fkey FOREIGN KEY (rd_code_id) REFERENCES public.tender_rd_codes(id) ON DELETE CASCADE;


--
-- Name: tender_vor_supply_rates tender_vor_supply_rates_tender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_vor_supply_rates
    ADD CONSTRAINT tender_vor_supply_rates_tender_id_fkey FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE CASCADE;


--
-- Name: tender_winners tender_winners_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_winners
    ADD CONSTRAINT tender_winners_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE CASCADE;


--
-- Name: tender_winners tender_winners_tender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tender_winners
    ADD CONSTRAINT tender_winners_tender_id_fkey FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE CASCADE;


--
-- Name: tenders tenders_cost_plan_responsible_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenders
    ADD CONSTRAINT tenders_cost_plan_responsible_id_fkey FOREIGN KEY (cost_plan_responsible_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: tenders tenders_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenders
    ADD CONSTRAINT tenders_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: tenders tenders_parent_tender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenders
    ADD CONSTRAINT tenders_parent_tender_id_fkey FOREIGN KEY (parent_tender_id) REFERENCES public.tenders(id) ON DELETE CASCADE;


--
-- Name: tenders tenders_responsible_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenders
    ADD CONSTRAINT tenders_responsible_contact_id_fkey FOREIGN KEY (responsible_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: tenders tenders_responsible_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenders
    ADD CONSTRAINT tenders_responsible_employee_id_fkey FOREIGN KEY (responsible_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: tenders tenders_vor_responsible_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenders
    ADD CONSTRAINT tenders_vor_responsible_id_fkey FOREIGN KEY (vor_responsible_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: tenders tenders_winner_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tenders
    ADD CONSTRAINT tenders_winner_counterparty_id_fkey FOREIGN KEY (winner_counterparty_id) REFERENCES public.counterparties(id) ON DELETE SET NULL;


--
-- Name: user_roles user_roles_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE RESTRICT;


--
-- Name: user_roles user_roles_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: vor_requests vor_requests_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.vor_requests
    ADD CONSTRAINT vor_requests_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id) ON DELETE SET NULL;


--
-- Name: vor_requests vor_requests_tender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.vor_requests
    ADD CONSTRAINT vor_requests_tender_id_fkey FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE SET NULL;


--
-- Name: audit_log_entries; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.audit_log_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_state; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.flow_state ENABLE ROW LEVEL SECURITY;

--
-- Name: identities; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.identities ENABLE ROW LEVEL SECURITY;

--
-- Name: instances; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.instances ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_amr_claims; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.mfa_amr_claims ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_challenges; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.mfa_challenges ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_factors; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.mfa_factors ENABLE ROW LEVEL SECURITY;

--
-- Name: one_time_tokens; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.one_time_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: refresh_tokens; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.refresh_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: saml_providers; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.saml_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: saml_relay_states; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.saml_relay_states ENABLE ROW LEVEL SECURITY;

--
-- Name: schema_migrations; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.schema_migrations ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: sso_domains; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.sso_domains ENABLE ROW LEVEL SECURITY;

--
-- Name: sso_providers; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.sso_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: auth; Owner: supabase_auth_admin
--

ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;

--
-- Name: bsm_supply_rates Allow all for authenticated; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated" ON public.bsm_supply_rates TO authenticated USING (true) WITH CHECK (true);


--
-- Name: app_settings Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.app_settings TO authenticated USING (true) WITH CHECK (true);


--
-- Name: bsm_contract_rates Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.bsm_contract_rates TO authenticated USING (true) WITH CHECK (true);


--
-- Name: bsm_contractor_rates Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.bsm_contractor_rates TO authenticated USING (true) WITH CHECK (true);


--
-- Name: contract_appendices Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.contract_appendices TO authenticated USING (true) WITH CHECK (true);


--
-- Name: contract_attachments Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.contract_attachments TO authenticated USING (true) WITH CHECK (true);


--
-- Name: contract_audit_log Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.contract_audit_log TO authenticated USING (true) WITH CHECK (true);


--
-- Name: counterparty_audit_log Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.counterparty_audit_log TO authenticated USING (true) WITH CHECK (true);


--
-- Name: counterparty_relations Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.counterparty_relations TO authenticated USING (true) WITH CHECK (true);


--
-- Name: dc_request_audit_log Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.dc_request_audit_log TO authenticated USING (true) WITH CHECK (true);


--
-- Name: departments Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.departments TO authenticated USING (true) WITH CHECK (true);


--
-- Name: document_check_requests Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.document_check_requests TO authenticated USING (true) WITH CHECK (true);


--
-- Name: employees Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.employees TO authenticated USING (true) WITH CHECK (true);


--
-- Name: general_document_folders Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.general_document_folders TO authenticated USING (true) WITH CHECK (true);


--
-- Name: general_document_links Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.general_document_links TO authenticated USING (true) WITH CHECK (true);


--
-- Name: general_documents Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.general_documents TO authenticated USING (true) WITH CHECK (true);


--
-- Name: object_areas Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.object_areas TO authenticated USING (true) WITH CHECK (true);


--
-- Name: object_contract_attachments Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.object_contract_attachments TO authenticated USING (true) WITH CHECK (true);


--
-- Name: object_staff Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.object_staff TO authenticated USING (true) WITH CHECK (true);


--
-- Name: object_warranties Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.object_warranties TO authenticated USING (true) WITH CHECK (true);


--
-- Name: object_warranty_retention_payments Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.object_warranty_retention_payments TO authenticated USING (true) WITH CHECK (true);


--
-- Name: object_warranty_retentions Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.object_warranty_retentions TO authenticated USING (true) WITH CHECK (true);


--
-- Name: positions Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.positions TO authenticated USING (true) WITH CHECK (true);


--
-- Name: tender_audit_log Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.tender_audit_log TO authenticated USING (true) WITH CHECK (true);


--
-- Name: tender_doc_links Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.tender_doc_links TO authenticated USING (true) WITH CHECK (true);


--
-- Name: tender_docs Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.tender_docs TO authenticated USING (true) WITH CHECK (true);


--
-- Name: tender_rd_codes Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.tender_rd_codes TO authenticated USING (true) WITH CHECK (true);


--
-- Name: tender_vor_supply_rates Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.tender_vor_supply_rates TO authenticated USING (true) WITH CHECK (true);


--
-- Name: tender_winners Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.tender_winners TO authenticated USING (true) WITH CHECK (true);


--
-- Name: work_types Allow all for authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users" ON public.work_types TO authenticated USING (true) WITH CHECK (true);


--
-- Name: contract_advance_schedule Allow all for authenticated users on contract_advance_schedule; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users on contract_advance_schedule" ON public.contract_advance_schedule TO authenticated USING (true) WITH CHECK (true);


--
-- Name: contract_psdc_items Allow all for authenticated users on contract_psdc_items; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users on contract_psdc_items" ON public.contract_psdc_items TO authenticated USING (true) WITH CHECK (true);


--
-- Name: object_cost_plan Allow all for authenticated users on object_cost_plan; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users on object_cost_plan" ON public.object_cost_plan TO authenticated USING (true) WITH CHECK (true);


--
-- Name: object_documents Allow all for authenticated users on object_documents; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow all for authenticated users on object_documents" ON public.object_documents TO authenticated USING (true) WITH CHECK (true);


--
-- Name: objects Anon public objects via open tenders; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Anon public objects via open tenders" ON public.objects FOR SELECT TO anon USING ((EXISTS ( SELECT 1
   FROM public.tenders t
  WHERE ((t.object_id = objects.id) AND ((t.status)::text = 'Идет тендерная процедура'::text) AND (t.deleted_at IS NULL) AND ((t.tender_type IS NULL) OR (t.tender_type = 'main'::text))))));


--
-- Name: tenders Anon public tender list; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Anon public tender list" ON public.tenders FOR SELECT TO anon USING ((((status)::text = 'Идет тендерная процедура'::text) AND (deleted_at IS NULL) AND ((tender_type IS NULL) OR (tender_type = 'main'::text))));


--
-- Name: dc_request_tasks Enable all for dc_request_tasks; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Enable all for dc_request_tasks" ON public.dc_request_tasks TO authenticated USING (true) WITH CHECK (true);


--
-- Name: dc_requests Enable all for dc_requests; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Enable all for dc_requests" ON public.dc_requests TO authenticated USING (true) WITH CHECK (true);


--
-- Name: tender_proposal_files Enable all for tender_proposal_files; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Enable all for tender_proposal_files" ON public.tender_proposal_files TO authenticated USING (true) WITH CHECK (true);


--
-- Name: app_settings; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: bsm_contract_rates; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.bsm_contract_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: bsm_contractor_rates; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.bsm_contractor_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: bsm_supply_rates; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.bsm_supply_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_clauses clauses_contractor_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY clauses_contractor_read ON public.contract_clauses FOR SELECT TO authenticated USING (public.is_my_contract(contract_id));


--
-- Name: contract_clauses clauses_employee_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY clauses_employee_all ON public.contract_clauses TO authenticated USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());


--
-- Name: client_errors; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;

--
-- Name: client_errors client_errors_select_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY client_errors_select_admin ON public.client_errors FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: client_versions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.client_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: client_versions client_versions_select_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY client_versions_select_admin ON public.client_versions FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: contract_clause_comments comments_contractor_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY comments_contractor_insert ON public.contract_clause_comments FOR INSERT TO authenticated WITH CHECK (((counterparty_id = public.current_counterparty_id()) AND (author_side = 'contractor'::text) AND (EXISTS ( SELECT 1
   FROM public.contract_clause_disputes d
  WHERE ((d.id = contract_clause_comments.dispute_id) AND (d.counterparty_id = public.current_counterparty_id()))))));


--
-- Name: contract_clause_comments comments_contractor_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY comments_contractor_select ON public.contract_clause_comments FOR SELECT TO authenticated USING ((counterparty_id = public.current_counterparty_id()));


--
-- Name: contract_clause_comments comments_employee_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY comments_employee_all ON public.contract_clause_comments TO authenticated USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());


--
-- Name: contacts; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_advance_schedule; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.contract_advance_schedule ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_appendices; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.contract_appendices ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_attachments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.contract_attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_audit_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.contract_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_clause_comments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.contract_clause_comments ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_clause_dispute_clauses; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.contract_clause_dispute_clauses ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_clause_disputes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.contract_clause_disputes ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_clauses; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.contract_clauses ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_counterparties; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.contract_counterparties ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_psdc_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.contract_psdc_items ENABLE ROW LEVEL SECURITY;

--
-- Name: contracts; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;

--
-- Name: counterparties; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.counterparties ENABLE ROW LEVEL SECURITY;

--
-- Name: counterparties_inn_backup_2026_09_21; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.counterparties_inn_backup_2026_09_21 ENABLE ROW LEVEL SECURITY;

--
-- Name: counterparty_audit_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.counterparty_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: counterparty_contacts; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.counterparty_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: counterparty_relations; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.counterparty_relations ENABLE ROW LEVEL SECURITY;

--
-- Name: dc_request_audit_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.dc_request_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: dc_request_tasks; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.dc_request_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: dc_requests; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.dc_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: departments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_clause_dispute_clauses dispute_clauses_contractor; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY dispute_clauses_contractor ON public.contract_clause_dispute_clauses TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.contract_clause_disputes d
  WHERE ((d.id = contract_clause_dispute_clauses.dispute_id) AND (d.counterparty_id = public.current_counterparty_id()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.contract_clause_disputes d
  WHERE ((d.id = contract_clause_dispute_clauses.dispute_id) AND (d.counterparty_id = public.current_counterparty_id())))));


--
-- Name: contract_clause_dispute_clauses dispute_clauses_employee_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY dispute_clauses_employee_all ON public.contract_clause_dispute_clauses TO authenticated USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());


--
-- Name: contract_clause_disputes disputes_contractor_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY disputes_contractor_insert ON public.contract_clause_disputes FOR INSERT TO authenticated WITH CHECK (((counterparty_id = public.current_counterparty_id()) AND public.is_my_contract(contract_id)));


--
-- Name: contract_clause_disputes disputes_contractor_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY disputes_contractor_select ON public.contract_clause_disputes FOR SELECT TO authenticated USING ((counterparty_id = public.current_counterparty_id()));


--
-- Name: contract_clause_disputes disputes_contractor_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY disputes_contractor_update ON public.contract_clause_disputes FOR UPDATE TO authenticated USING ((counterparty_id = public.current_counterparty_id())) WITH CHECK ((counterparty_id = public.current_counterparty_id()));


--
-- Name: contract_clause_disputes disputes_employee_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY disputes_employee_all ON public.contract_clause_disputes TO authenticated USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());


--
-- Name: doc_check_request_audit_log doc_check_audit_employee_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY doc_check_audit_employee_all ON public.doc_check_request_audit_log TO authenticated USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());


--
-- Name: doc_check_request_audit_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.doc_check_request_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: doc_check_requests; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.doc_check_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: doc_check_requests doc_check_requests_employee_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY doc_check_requests_employee_all ON public.doc_check_requests TO authenticated USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());


--
-- Name: document_check_requests; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.document_check_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: employees; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

--
-- Name: general_document_folders; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.general_document_folders ENABLE ROW LEVEL SECURITY;

--
-- Name: general_document_links; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.general_document_links ENABLE ROW LEVEL SECURITY;

--
-- Name: general_documents; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.general_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: object_areas; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.object_areas ENABLE ROW LEVEL SECURITY;

--
-- Name: object_contract_attachments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.object_contract_attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: object_cost_plan; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.object_cost_plan ENABLE ROW LEVEL SECURITY;

--
-- Name: object_documents; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.object_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: object_estimate_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.object_estimate_items ENABLE ROW LEVEL SECURITY;

--
-- Name: object_staff; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.object_staff ENABLE ROW LEVEL SECURITY;

--
-- Name: object_warranties; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.object_warranties ENABLE ROW LEVEL SECURITY;

--
-- Name: object_warranty_retention_payments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.object_warranty_retention_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: object_warranty_retentions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.object_warranty_retentions ENABLE ROW LEVEL SECURITY;

--
-- Name: objects; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.objects ENABLE ROW LEVEL SECURITY;

--
-- Name: tender_counterparty_proposals portal_contractor_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_contractor_delete ON public.tender_counterparty_proposals FOR DELETE TO authenticated USING ((counterparty_id = public.current_counterparty_id()));


--
-- Name: tender_counterparty_proposals portal_contractor_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_contractor_insert ON public.tender_counterparty_proposals FOR INSERT TO authenticated WITH CHECK (((counterparty_id = public.current_counterparty_id()) AND public.is_my_tender(tender_id)));


--
-- Name: contract_counterparties portal_contractor_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_contractor_select ON public.contract_counterparties FOR SELECT TO authenticated USING ((counterparty_id = public.current_counterparty_id()));


--
-- Name: contracts portal_contractor_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_contractor_select ON public.contracts FOR SELECT TO authenticated USING (((deleted_at IS NULL) AND public.is_my_contract(id)));


--
-- Name: counterparties portal_contractor_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_contractor_select ON public.counterparties FOR SELECT TO authenticated USING ((id = public.current_counterparty_id()));


--
-- Name: objects portal_contractor_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_contractor_select ON public.objects FOR SELECT TO authenticated USING (((public.current_counterparty_id() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (public.tenders t
     JOIN public.tender_counterparties tc ON ((tc.tender_id = t.id)))
  WHERE ((t.object_id = objects.id) AND (tc.counterparty_id = public.current_counterparty_id()))))));


--
-- Name: s3_documents portal_contractor_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_contractor_select ON public.s3_documents FOR SELECT TO authenticated USING ((((owner_type = 'tender'::text) AND (doc_category = ANY (ARRAY['tender_package'::text, 'vor'::text, 'rd'::text, 'vor_statement'::text])) AND public.is_my_tender(owner_id)) OR ((owner_type = 'contract'::text) AND public.is_my_contract(owner_id))));


--
-- Name: tender_counterparties portal_contractor_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_contractor_select ON public.tender_counterparties FOR SELECT TO authenticated USING ((counterparty_id = public.current_counterparty_id()));


--
-- Name: tender_counterparty_proposals portal_contractor_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_contractor_select ON public.tender_counterparty_proposals FOR SELECT TO authenticated USING ((counterparty_id = public.current_counterparty_id()));


--
-- Name: tender_estimate_items portal_contractor_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_contractor_select ON public.tender_estimate_items FOR SELECT TO authenticated USING (public.is_my_tender(tender_id));


--
-- Name: tenders portal_contractor_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_contractor_select ON public.tenders FOR SELECT TO authenticated USING (public.is_my_tender(id));


--
-- Name: tender_counterparties portal_contractor_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_contractor_update ON public.tender_counterparties FOR UPDATE TO authenticated USING ((counterparty_id = public.current_counterparty_id())) WITH CHECK ((counterparty_id = public.current_counterparty_id()));


--
-- Name: contract_counterparties portal_employee_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_employee_all ON public.contract_counterparties TO authenticated USING (public.is_portal_employee()) WITH CHECK (public.is_portal_employee());


--
-- Name: contracts portal_employee_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_employee_all ON public.contracts TO authenticated USING (public.is_portal_employee()) WITH CHECK (public.is_portal_employee());


--
-- Name: s3_documents portal_employee_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_employee_all ON public.s3_documents TO authenticated USING (public.is_portal_employee()) WITH CHECK (public.is_portal_employee());


--
-- Name: tender_counterparties portal_employee_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_employee_all ON public.tender_counterparties TO authenticated USING (public.is_portal_employee()) WITH CHECK (public.is_portal_employee());


--
-- Name: tender_counterparty_proposals portal_employee_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_employee_all ON public.tender_counterparty_proposals TO authenticated USING (public.is_portal_employee()) WITH CHECK (public.is_portal_employee());


--
-- Name: tender_estimate_items portal_employee_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_employee_all ON public.tender_estimate_items TO authenticated USING (public.is_portal_employee()) WITH CHECK (public.is_portal_employee());


--
-- Name: tenders portal_employee_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY portal_employee_all ON public.tenders TO authenticated USING (public.is_portal_employee()) WITH CHECK (public.is_portal_employee());


--
-- Name: positions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;

--
-- Name: psdc; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.psdc ENABLE ROW LEVEL SECURITY;

--
-- Name: psdc_batches; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.psdc_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: psdc_batches psdc_batches_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY psdc_batches_select ON public.psdc_batches FOR SELECT TO authenticated USING (((created_by = auth.uid()) OR public.psdc_contracts_permission(true)));


--
-- Name: psdc_issues; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.psdc_issues ENABLE ROW LEVEL SECURITY;

--
-- Name: psdc_issues psdc_issues_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY psdc_issues_select ON public.psdc_issues FOR SELECT TO authenticated USING (public.psdc_visible(psdc_id));


--
-- Name: psdc_rows; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.psdc_rows ENABLE ROW LEVEL SECURITY;

--
-- Name: psdc_rows psdc_rows_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY psdc_rows_select ON public.psdc_rows FOR SELECT TO authenticated USING (public.psdc_visible(psdc_id));


--
-- Name: psdc psdc_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY psdc_select ON public.psdc FOR SELECT TO authenticated USING (
CASE
    WHEN (document_id IS NULL) THEN ((uploaded_by = auth.uid()) OR public.psdc_contracts_permission(true))
    ELSE public.psdc_can_view_document(document_id)
END);


--
-- Name: psdc_source_rows; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.psdc_source_rows ENABLE ROW LEVEL SECURITY;

--
-- Name: psdc_source_rows psdc_source_rows_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY psdc_source_rows_select ON public.psdc_source_rows FOR SELECT TO authenticated USING (public.psdc_visible(psdc_id));


--
-- Name: tender_rd_document_codes rd_doc_codes_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY rd_doc_codes_select ON public.tender_rd_document_codes FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.s3_documents d
  WHERE (d.id = tender_rd_document_codes.document_id))));


--
-- Name: tender_rd_document_codes rd_doc_codes_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY rd_doc_codes_write ON public.tender_rd_document_codes TO authenticated USING ((NOT (EXISTS ( SELECT 1
   FROM public.user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.role = 'contractor'::text)))))) WITH CHECK (((NOT (EXISTS ( SELECT 1
   FROM public.user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.role = 'contractor'::text))))) AND (EXISTS ( SELECT 1
   FROM (public.s3_documents d
     JOIN public.tender_rd_codes c ON ((c.tender_id = d.owner_id)))
  WHERE ((d.id = tender_rd_document_codes.document_id) AND (c.id = tender_rd_document_codes.rd_code_id) AND (d.owner_type = 'tender'::text))))));


--
-- Name: contacts rls_authenticated_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY rls_authenticated_all ON public.contacts TO authenticated USING (true) WITH CHECK (true);


--
-- Name: counterparties rls_authenticated_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY rls_authenticated_all ON public.counterparties TO authenticated USING (true) WITH CHECK (true);


--
-- Name: counterparty_contacts rls_authenticated_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY rls_authenticated_all ON public.counterparty_contacts TO authenticated USING (true) WITH CHECK (true);


--
-- Name: object_estimate_items rls_authenticated_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY rls_authenticated_all ON public.object_estimate_items TO authenticated USING (true) WITH CHECK (true);


--
-- Name: objects rls_authenticated_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY rls_authenticated_all ON public.objects TO authenticated USING (true) WITH CHECK (true);


--
-- Name: tender_documents rls_authenticated_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY rls_authenticated_all ON public.tender_documents TO authenticated USING (true) WITH CHECK (true);


--
-- Name: role_permissions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: role_permissions role_permissions_modify_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY role_permissions_modify_admin ON public.role_permissions TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: role_permissions role_permissions_select_auth; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY role_permissions_select_auth ON public.role_permissions FOR SELECT TO authenticated USING (true);


--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: roles roles_modify_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY roles_modify_admin ON public.roles TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: roles roles_select_auth; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY roles_select_auth ON public.roles FOR SELECT TO authenticated USING (true);


--
-- Name: s3_documents; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.s3_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: task_audit_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.task_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: task_audit_log task_audit_log_visible; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY task_audit_log_visible ON public.task_audit_log TO authenticated USING ((public.is_negotiation_employee() AND public.can_see_task(task_id))) WITH CHECK ((public.is_negotiation_employee() AND public.can_see_task(task_id)));


--
-- Name: task_checklist_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.task_checklist_items ENABLE ROW LEVEL SECURITY;

--
-- Name: task_checklist_items task_checklist_visible; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY task_checklist_visible ON public.task_checklist_items TO authenticated USING ((public.is_negotiation_employee() AND public.can_see_task(task_id))) WITH CHECK ((public.is_negotiation_employee() AND public.can_see_task(task_id)));


--
-- Name: task_comments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.task_comments ENABLE ROW LEVEL SECURITY;

--
-- Name: task_comments task_comments_visible; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY task_comments_visible ON public.task_comments TO authenticated USING ((public.is_negotiation_employee() AND public.can_see_task(task_id))) WITH CHECK ((public.is_negotiation_employee() AND public.can_see_task(task_id)));


--
-- Name: task_participants; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.task_participants ENABLE ROW LEVEL SECURITY;

--
-- Name: task_participants task_participants_visible; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY task_participants_visible ON public.task_participants TO authenticated USING ((public.is_negotiation_employee() AND public.can_see_task(task_id))) WITH CHECK ((public.is_negotiation_employee() AND public.can_see_task(task_id)));


--
-- Name: tasks; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: tasks tasks_delete_visible; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tasks_delete_visible ON public.tasks FOR DELETE TO authenticated USING ((public.is_negotiation_employee() AND (public.is_admin() OR (assignee_user_id = auth.uid()) OR (created_by_user_id = auth.uid()) OR public.is_task_participant(id))));


--
-- Name: tasks tasks_insert_employee; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tasks_insert_employee ON public.tasks FOR INSERT TO authenticated WITH CHECK ((public.is_negotiation_employee() AND (public.is_admin() OR (created_by_user_id = auth.uid()))));


--
-- Name: tasks tasks_select_visible; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tasks_select_visible ON public.tasks FOR SELECT TO authenticated USING ((public.is_negotiation_employee() AND (public.is_admin() OR (assignee_user_id = auth.uid()) OR (created_by_user_id = auth.uid()) OR public.is_task_participant(id))));


--
-- Name: tasks tasks_update_visible; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY tasks_update_visible ON public.tasks FOR UPDATE TO authenticated USING ((public.is_negotiation_employee() AND (public.is_admin() OR (assignee_user_id = auth.uid()) OR (created_by_user_id = auth.uid()) OR public.is_task_participant(id)))) WITH CHECK (public.is_negotiation_employee());


--
-- Name: tender_audit_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tender_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: tender_counterparties; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tender_counterparties ENABLE ROW LEVEL SECURITY;

--
-- Name: tender_counterparty_proposals; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tender_counterparty_proposals ENABLE ROW LEVEL SECURITY;

--
-- Name: tender_doc_links; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tender_doc_links ENABLE ROW LEVEL SECURITY;

--
-- Name: tender_docs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tender_docs ENABLE ROW LEVEL SECURITY;

--
-- Name: tender_documents; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tender_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: tender_estimate_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tender_estimate_items ENABLE ROW LEVEL SECURITY;

--
-- Name: tender_proposal_files; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tender_proposal_files ENABLE ROW LEVEL SECURITY;

--
-- Name: tender_rd_codes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tender_rd_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: tender_rd_document_codes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tender_rd_document_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: tender_vor_supply_rates; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tender_vor_supply_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: tender_winners; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tender_winners ENABLE ROW LEVEL SECURITY;

--
-- Name: tenders; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tenders ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles user_roles_delete_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY user_roles_delete_admin ON public.user_roles FOR DELETE TO authenticated USING (public.is_admin());


--
-- Name: user_roles user_roles_insert_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY user_roles_insert_admin ON public.user_roles FOR INSERT TO authenticated WITH CHECK (public.is_admin());


--
-- Name: user_roles user_roles_insert_self_pending; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY user_roles_insert_self_pending ON public.user_roles FOR INSERT TO authenticated WITH CHECK (((user_id = auth.uid()) AND (is_approved = false) AND (role = ANY (ARRAY['contractor'::text, 'engineer'::text]))));


--
-- Name: user_roles user_roles_select_self_or_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY user_roles_select_self_or_admin ON public.user_roles FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR public.is_admin()));


--
-- Name: user_roles user_roles_update_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY user_roles_update_admin ON public.user_roles FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: vor_requests; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.vor_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: vor_requests vor_requests_employees; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY vor_requests_employees ON public.vor_requests TO authenticated USING (public.vor_requests_can_access()) WITH CHECK (public.vor_requests_can_access());


--
-- Name: work_types; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.work_types ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA auth; Type: ACL; Schema: -; Owner: supabase_admin
--

GRANT USAGE ON SCHEMA auth TO anon;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT ALL ON SCHEMA auth TO supabase_auth_admin;
GRANT ALL ON SCHEMA auth TO dashboard_user;
GRANT USAGE ON SCHEMA auth TO postgres;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION email(); Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON FUNCTION auth.email() TO dashboard_user;


--
-- Name: FUNCTION jwt(); Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON FUNCTION auth.jwt() TO postgres;
GRANT ALL ON FUNCTION auth.jwt() TO dashboard_user;


--
-- Name: FUNCTION role(); Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON FUNCTION auth.role() TO dashboard_user;


--
-- Name: FUNCTION uid(); Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON FUNCTION auth.uid() TO dashboard_user;


--
-- Name: FUNCTION admin_confirm_user_email(target_user_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.admin_confirm_user_email(target_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_confirm_user_email(target_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_confirm_user_email(target_user_id uuid) TO service_role;


--
-- Name: FUNCTION admin_delete_user(target_user_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.admin_delete_user(target_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_delete_user(target_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_delete_user(target_user_id uuid) TO service_role;


--
-- Name: FUNCTION can_see_task(task_uuid uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.can_see_task(task_uuid uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.can_see_task(task_uuid uuid) TO anon;
GRANT ALL ON FUNCTION public.can_see_task(task_uuid uuid) TO authenticated;
GRANT ALL ON FUNCTION public.can_see_task(task_uuid uuid) TO service_role;


--
-- Name: FUNCTION contracts_delete_guard(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.contracts_delete_guard() TO anon;
GRANT ALL ON FUNCTION public.contracts_delete_guard() TO authenticated;
GRANT ALL ON FUNCTION public.contracts_delete_guard() TO service_role;


--
-- Name: FUNCTION contracts_hierarchy_guard(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.contracts_hierarchy_guard() TO anon;
GRANT ALL ON FUNCTION public.contracts_hierarchy_guard() TO authenticated;
GRANT ALL ON FUNCTION public.contracts_hierarchy_guard() TO service_role;


--
-- Name: FUNCTION contracts_psdc_total_guard(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.contracts_psdc_total_guard() TO anon;
GRANT ALL ON FUNCTION public.contracts_psdc_total_guard() TO authenticated;
GRANT ALL ON FUNCTION public.contracts_psdc_total_guard() TO service_role;


--
-- Name: FUNCTION current_counterparty_id(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.current_counterparty_id() FROM PUBLIC;
GRANT ALL ON FUNCTION public.current_counterparty_id() TO anon;
GRANT ALL ON FUNCTION public.current_counterparty_id() TO authenticated;
GRANT ALL ON FUNCTION public.current_counterparty_id() TO service_role;


--
-- Name: FUNCTION general_document_folders_validate(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.general_document_folders_validate() TO anon;
GRANT ALL ON FUNCTION public.general_document_folders_validate() TO authenticated;
GRANT ALL ON FUNCTION public.general_document_folders_validate() TO service_role;


--
-- Name: FUNCTION general_documents_sync_folder_category(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.general_documents_sync_folder_category() TO anon;
GRANT ALL ON FUNCTION public.general_documents_sync_folder_category() TO authenticated;
GRANT ALL ON FUNCTION public.general_documents_sync_folder_category() TO service_role;


--
-- Name: FUNCTION get_auth_users(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.get_auth_users() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_auth_users() TO authenticated;
GRANT ALL ON FUNCTION public.get_auth_users() TO service_role;


--
-- Name: FUNCTION is_admin(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_admin() TO anon;
GRANT ALL ON FUNCTION public.is_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_admin() TO service_role;


--
-- Name: FUNCTION is_my_contract(contract_uuid uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.is_my_contract(contract_uuid uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_my_contract(contract_uuid uuid) TO anon;
GRANT ALL ON FUNCTION public.is_my_contract(contract_uuid uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_my_contract(contract_uuid uuid) TO service_role;


--
-- Name: FUNCTION is_my_tender(tender_uuid uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.is_my_tender(tender_uuid uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_my_tender(tender_uuid uuid) TO anon;
GRANT ALL ON FUNCTION public.is_my_tender(tender_uuid uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_my_tender(tender_uuid uuid) TO service_role;


--
-- Name: FUNCTION is_negotiation_employee(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.is_negotiation_employee() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_negotiation_employee() TO anon;
GRANT ALL ON FUNCTION public.is_negotiation_employee() TO authenticated;
GRANT ALL ON FUNCTION public.is_negotiation_employee() TO service_role;


--
-- Name: FUNCTION is_portal_employee(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.is_portal_employee() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_portal_employee() TO anon;
GRANT ALL ON FUNCTION public.is_portal_employee() TO authenticated;
GRANT ALL ON FUNCTION public.is_portal_employee() TO service_role;


--
-- Name: FUNCTION is_task_participant(task_uuid uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.is_task_participant(task_uuid uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_task_participant(task_uuid uuid) TO anon;
GRANT ALL ON FUNCTION public.is_task_participant(task_uuid uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_task_participant(task_uuid uuid) TO service_role;


--
-- Name: FUNCTION kp_norm_name(s text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.kp_norm_name(s text) TO anon;
GRANT ALL ON FUNCTION public.kp_norm_name(s text) TO authenticated;
GRANT ALL ON FUNCTION public.kp_norm_name(s text) TO service_role;


--
-- Name: FUNCTION kp_norm_unit(u text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.kp_norm_unit(u text) TO anon;
GRANT ALL ON FUNCTION public.kp_norm_unit(u text) TO authenticated;
GRANT ALL ON FUNCTION public.kp_norm_unit(u text) TO service_role;


--
-- Name: FUNCTION list_sto_employees(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.list_sto_employees() FROM PUBLIC;
GRANT ALL ON FUNCTION public.list_sto_employees() TO authenticated;
GRANT ALL ON FUNCTION public.list_sto_employees() TO service_role;


--
-- Name: FUNCTION list_supply_employees(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.list_supply_employees() FROM PUBLIC;
GRANT ALL ON FUNCTION public.list_supply_employees() TO authenticated;
GRANT ALL ON FUNCTION public.list_supply_employees() TO service_role;


--
-- Name: FUNCTION protect_dispute_columns(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.protect_dispute_columns() TO anon;
GRANT ALL ON FUNCTION public.protect_dispute_columns() TO authenticated;
GRANT ALL ON FUNCTION public.protect_dispute_columns() TO service_role;


--
-- Name: FUNCTION psdc_actor(OUT user_id uuid, OUT full_name text, OUT role text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_actor(OUT user_id uuid, OUT full_name text, OUT role text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_actor(OUT user_id uuid, OUT full_name text, OUT role text) TO service_role;


--
-- Name: FUNCTION psdc_add_rows(p_psdc_id uuid, p_rows jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_add_rows(p_psdc_id uuid, p_rows jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_add_rows(p_psdc_id uuid, p_rows jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_add_rows(p_psdc_id uuid, p_rows jsonb) TO service_role;


--
-- Name: FUNCTION psdc_apply(p_psdc_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_apply(p_psdc_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_apply(p_psdc_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_apply(p_psdc_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_audit(p_document_id uuid, p_event text, p_description text, p_payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_audit(p_document_id uuid, p_event text, p_description text, p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_audit(p_document_id uuid, p_event text, p_description text, p_payload jsonb) TO service_role;


--
-- Name: FUNCTION psdc_batch_apply(p_psdc_ids uuid[]); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_batch_apply(p_psdc_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_batch_apply(p_psdc_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_batch_apply(p_psdc_ids uuid[]) TO service_role;


--
-- Name: FUNCTION psdc_batch_create(p_title text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_batch_create(p_title text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_batch_create(p_title text) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_batch_create(p_title text) TO service_role;


--
-- Name: FUNCTION psdc_batch_issues(p_batch_id uuid, p_severity text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_batch_issues(p_batch_id uuid, p_severity text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_batch_issues(p_batch_id uuid, p_severity text) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_batch_issues(p_batch_id uuid, p_severity text) TO service_role;


--
-- Name: FUNCTION psdc_batch_items(p_batch_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_batch_items(p_batch_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_batch_items(p_batch_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_batch_items(p_batch_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_batch_set_documents(p_items jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_batch_set_documents(p_items jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_batch_set_documents(p_items jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_batch_set_documents(p_items jsonb) TO service_role;


--
-- Name: FUNCTION psdc_batch_set_notes(p_items jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_batch_set_notes(p_items jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_batch_set_notes(p_items jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_batch_set_notes(p_items jsonb) TO service_role;


--
-- Name: FUNCTION psdc_can_edit_document(p_document_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_can_edit_document(p_document_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_can_edit_document(p_document_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_can_view_document(p_document_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_can_view_document(p_document_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_can_view_document(p_document_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.psdc_can_view_document(p_document_id uuid) TO authenticated;


--
-- Name: FUNCTION psdc_cancel(p_psdc_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_cancel(p_psdc_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_cancel(p_psdc_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_cancel(p_psdc_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_cell_value(p_cell jsonb); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.psdc_cell_value(p_cell jsonb) TO anon;
GRANT ALL ON FUNCTION public.psdc_cell_value(p_cell jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_cell_value(p_cell jsonb) TO service_role;


--
-- Name: FUNCTION psdc_compare(p_psdc_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_compare(p_psdc_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_compare(p_psdc_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_compare(p_psdc_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_contracts_permission(p_edit boolean); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_contracts_permission(p_edit boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_contracts_permission(p_edit boolean) TO service_role;
GRANT ALL ON FUNCTION public.psdc_contracts_permission(p_edit boolean) TO authenticated;


--
-- Name: FUNCTION psdc_create(p_document_id uuid, p_batch_id uuid, p_meta jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_create(p_document_id uuid, p_batch_id uuid, p_meta jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_create(p_document_id uuid, p_batch_id uuid, p_meta jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_create(p_document_id uuid, p_batch_id uuid, p_meta jsonb) TO service_role;


--
-- Name: FUNCTION psdc_delete(p_psdc_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_delete(p_psdc_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_delete(p_psdc_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_delete(p_psdc_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_discard_internal(p_psdc_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_discard_internal(p_psdc_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_discard_internal(p_psdc_id uuid) TO service_role;


--
-- Name: TABLE contracts; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.contracts TO anon;
GRANT ALL ON TABLE public.contracts TO authenticated;
GRANT ALL ON TABLE public.contracts TO service_role;


--
-- Name: FUNCTION psdc_document_lock_reason(p_doc public.contracts); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_document_lock_reason(p_doc public.contracts) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_document_lock_reason(p_doc public.contracts) TO service_role;


--
-- Name: FUNCTION psdc_document_state(p_document_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_document_state(p_document_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_document_state(p_document_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_document_state(p_document_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_document_vat(p_document_id uuid, OUT rate numeric, OUT includes boolean); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_document_vat(p_document_id uuid, OUT rate numeric, OUT includes boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_document_vat(p_document_id uuid, OUT rate numeric, OUT includes boolean) TO service_role;


--
-- Name: FUNCTION psdc_feature_started_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.psdc_feature_started_at() TO anon;
GRANT ALL ON FUNCTION public.psdc_feature_started_at() TO authenticated;
GRANT ALL ON FUNCTION public.psdc_feature_started_at() TO service_role;


--
-- Name: FUNCTION psdc_find_previous(p_document_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_find_previous(p_document_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_find_previous(p_document_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_get(p_psdc_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_get(p_psdc_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_get(p_psdc_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_get(p_psdc_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_get_rows(p_psdc_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_get_rows(p_psdc_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_get_rows(p_psdc_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_get_rows(p_psdc_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_json(p_psdc_id uuid, p_issue_limit integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_json(p_psdc_id uuid, p_issue_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_json(p_psdc_id uuid, p_issue_limit integer) TO service_role;


--
-- Name: FUNCTION psdc_log_export(p_psdc_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_log_export(p_psdc_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_log_export(p_psdc_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_log_export(p_psdc_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_norm_header(p_text text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.psdc_norm_header(p_text text) TO anon;
GRANT ALL ON FUNCTION public.psdc_norm_header(p_text text) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_norm_header(p_text text) TO service_role;


--
-- Name: FUNCTION psdc_number_message(p_label text, p_err text, p_raw text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.psdc_number_message(p_label text, p_err text, p_raw text) TO anon;
GRANT ALL ON FUNCTION public.psdc_number_message(p_label text, p_err text, p_raw text) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_number_message(p_label text, p_err text, p_raw text) TO service_role;


--
-- Name: FUNCTION psdc_object_in_scope(p_object_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_object_in_scope(p_object_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_object_in_scope(p_object_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_parse_decimal(p_cell jsonb); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.psdc_parse_decimal(p_cell jsonb) TO anon;
GRANT ALL ON FUNCTION public.psdc_parse_decimal(p_cell jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_parse_decimal(p_cell jsonb) TO service_role;


--
-- Name: FUNCTION psdc_set_source_file(p_psdc_id uuid, p_s3_document_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_set_source_file(p_psdc_id uuid, p_s3_document_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_set_source_file(p_psdc_id uuid, p_s3_document_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_set_source_file(p_psdc_id uuid, p_s3_document_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_validate(p_psdc_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_validate(p_psdc_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_validate(p_psdc_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.psdc_validate(p_psdc_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_validate_internal(p_psdc_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_validate_internal(p_psdc_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_validate_internal(p_psdc_id uuid) TO service_role;


--
-- Name: FUNCTION psdc_visible(p_psdc_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.psdc_visible(p_psdc_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.psdc_visible(p_psdc_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.psdc_visible(p_psdc_id uuid) TO authenticated;


--
-- Name: FUNCTION refresh_rates_registry(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.refresh_rates_registry() TO anon;
GRANT ALL ON FUNCTION public.refresh_rates_registry() TO authenticated;
GRANT ALL ON FUNCTION public.refresh_rates_registry() TO service_role;


--
-- Name: FUNCTION report_client_error(p_build_id text, p_section text, p_code text, p_status integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.report_client_error(p_build_id text, p_section text, p_code text, p_status integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.report_client_error(p_build_id text, p_section text, p_code text, p_status integer) TO authenticated;
GRANT ALL ON FUNCTION public.report_client_error(p_build_id text, p_section text, p_code text, p_status integer) TO service_role;


--
-- Name: FUNCTION report_client_version(p_build_id text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.report_client_version(p_build_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.report_client_version(p_build_id text) TO authenticated;
GRANT ALL ON FUNCTION public.report_client_version(p_build_id text) TO service_role;


--
-- Name: FUNCTION sync_tenders_department_from_object(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.sync_tenders_department_from_object() TO anon;
GRANT ALL ON FUNCTION public.sync_tenders_department_from_object() TO authenticated;
GRANT ALL ON FUNCTION public.sync_tenders_department_from_object() TO service_role;


--
-- Name: FUNCTION touch_last_login(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.touch_last_login() FROM PUBLIC;
GRANT ALL ON FUNCTION public.touch_last_login() TO anon;
GRANT ALL ON FUNCTION public.touch_last_login() TO authenticated;
GRANT ALL ON FUNCTION public.touch_last_login() TO service_role;


--
-- Name: FUNCTION update_bsm_approved_rates_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_bsm_approved_rates_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_bsm_approved_rates_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_bsm_approved_rates_updated_at() TO service_role;


--
-- Name: FUNCTION update_bsm_contract_rates_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_bsm_contract_rates_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_bsm_contract_rates_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_bsm_contract_rates_updated_at() TO service_role;


--
-- Name: FUNCTION update_bsm_contractor_rates_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_bsm_contractor_rates_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_bsm_contractor_rates_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_bsm_contractor_rates_updated_at() TO service_role;


--
-- Name: FUNCTION update_bsm_supply_rates_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_bsm_supply_rates_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_bsm_supply_rates_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_bsm_supply_rates_updated_at() TO service_role;


--
-- Name: FUNCTION update_clause_disputes_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_clause_disputes_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_clause_disputes_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_clause_disputes_updated_at() TO service_role;


--
-- Name: FUNCTION update_contacts_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_contacts_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_contacts_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_contacts_updated_at() TO service_role;


--
-- Name: FUNCTION update_contract_advance_schedule_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_contract_advance_schedule_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_contract_advance_schedule_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_contract_advance_schedule_updated_at() TO service_role;


--
-- Name: FUNCTION update_contract_clauses_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_contract_clauses_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_contract_clauses_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_contract_clauses_updated_at() TO service_role;


--
-- Name: FUNCTION update_contract_psdc_items_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_contract_psdc_items_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_contract_psdc_items_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_contract_psdc_items_updated_at() TO service_role;


--
-- Name: FUNCTION update_contracts_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_contracts_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_contracts_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_contracts_updated_at() TO service_role;


--
-- Name: FUNCTION update_counterparties_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_counterparties_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_counterparties_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_counterparties_updated_at() TO service_role;


--
-- Name: FUNCTION update_counterparty_contacts_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_counterparty_contacts_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_counterparty_contacts_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_counterparty_contacts_updated_at() TO service_role;


--
-- Name: FUNCTION update_doc_check_requests_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_doc_check_requests_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_doc_check_requests_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_doc_check_requests_updated_at() TO service_role;


--
-- Name: FUNCTION update_employees_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_employees_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_employees_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_employees_updated_at() TO service_role;


--
-- Name: FUNCTION update_object_cost_plan_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_object_cost_plan_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_object_cost_plan_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_object_cost_plan_updated_at() TO service_role;


--
-- Name: FUNCTION update_object_documents_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_object_documents_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_object_documents_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_object_documents_updated_at() TO service_role;


--
-- Name: FUNCTION update_object_estimate_items_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_object_estimate_items_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_object_estimate_items_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_object_estimate_items_updated_at() TO service_role;


--
-- Name: FUNCTION update_objects_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_objects_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_objects_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_objects_updated_at() TO service_role;


--
-- Name: FUNCTION update_tasks_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_tasks_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_tasks_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_tasks_updated_at() TO service_role;


--
-- Name: FUNCTION update_tender_counterparty_proposals_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_tender_counterparty_proposals_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_tender_counterparty_proposals_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_tender_counterparty_proposals_updated_at() TO service_role;


--
-- Name: FUNCTION update_tender_estimate_items_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_tender_estimate_items_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_tender_estimate_items_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_tender_estimate_items_updated_at() TO service_role;


--
-- Name: FUNCTION update_tender_vor_supply_rates_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_tender_vor_supply_rates_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_tender_vor_supply_rates_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_tender_vor_supply_rates_updated_at() TO service_role;


--
-- Name: FUNCTION update_tenders_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_tenders_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_tenders_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_tenders_updated_at() TO service_role;


--
-- Name: FUNCTION update_updated_at_column(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_updated_at_column() TO anon;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO authenticated;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO service_role;


--
-- Name: FUNCTION vor_requests_can_access(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.vor_requests_can_access() FROM PUBLIC;
GRANT ALL ON FUNCTION public.vor_requests_can_access() TO anon;
GRANT ALL ON FUNCTION public.vor_requests_can_access() TO authenticated;
GRANT ALL ON FUNCTION public.vor_requests_can_access() TO service_role;


--
-- Name: FUNCTION vor_requests_touch_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.vor_requests_touch_updated_at() TO anon;
GRANT ALL ON FUNCTION public.vor_requests_touch_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.vor_requests_touch_updated_at() TO service_role;


--
-- Name: TABLE audit_log_entries; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.audit_log_entries TO dashboard_user;
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.audit_log_entries TO postgres;
GRANT SELECT ON TABLE auth.audit_log_entries TO postgres WITH GRANT OPTION;


--
-- Name: TABLE custom_oauth_providers; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.custom_oauth_providers TO postgres;
GRANT ALL ON TABLE auth.custom_oauth_providers TO dashboard_user;


--
-- Name: TABLE flow_state; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.flow_state TO postgres;
GRANT SELECT ON TABLE auth.flow_state TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.flow_state TO dashboard_user;


--
-- Name: TABLE identities; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.identities TO postgres;
GRANT SELECT ON TABLE auth.identities TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.identities TO dashboard_user;


--
-- Name: TABLE instances; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.instances TO dashboard_user;
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.instances TO postgres;
GRANT SELECT ON TABLE auth.instances TO postgres WITH GRANT OPTION;


--
-- Name: TABLE mfa_amr_claims; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.mfa_amr_claims TO postgres;
GRANT SELECT ON TABLE auth.mfa_amr_claims TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.mfa_amr_claims TO dashboard_user;


--
-- Name: TABLE mfa_challenges; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.mfa_challenges TO postgres;
GRANT SELECT ON TABLE auth.mfa_challenges TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.mfa_challenges TO dashboard_user;


--
-- Name: TABLE mfa_factors; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.mfa_factors TO postgres;
GRANT SELECT ON TABLE auth.mfa_factors TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.mfa_factors TO dashboard_user;


--
-- Name: TABLE mfa_recovery_code_sets; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.mfa_recovery_code_sets TO postgres;
GRANT ALL ON TABLE auth.mfa_recovery_code_sets TO dashboard_user;


--
-- Name: TABLE mfa_recovery_codes; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.mfa_recovery_codes TO postgres;
GRANT ALL ON TABLE auth.mfa_recovery_codes TO dashboard_user;


--
-- Name: TABLE oauth_authorizations; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.oauth_authorizations TO postgres;
GRANT ALL ON TABLE auth.oauth_authorizations TO dashboard_user;


--
-- Name: TABLE oauth_client_states; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.oauth_client_states TO postgres;
GRANT ALL ON TABLE auth.oauth_client_states TO dashboard_user;


--
-- Name: TABLE oauth_clients; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.oauth_clients TO postgres;
GRANT ALL ON TABLE auth.oauth_clients TO dashboard_user;


--
-- Name: TABLE oauth_consents; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.oauth_consents TO postgres;
GRANT ALL ON TABLE auth.oauth_consents TO dashboard_user;


--
-- Name: TABLE one_time_tokens; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.one_time_tokens TO postgres;
GRANT SELECT ON TABLE auth.one_time_tokens TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.one_time_tokens TO dashboard_user;


--
-- Name: TABLE refresh_tokens; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.refresh_tokens TO dashboard_user;
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.refresh_tokens TO postgres;
GRANT SELECT ON TABLE auth.refresh_tokens TO postgres WITH GRANT OPTION;


--
-- Name: SEQUENCE refresh_tokens_id_seq; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON SEQUENCE auth.refresh_tokens_id_seq TO dashboard_user;
GRANT ALL ON SEQUENCE auth.refresh_tokens_id_seq TO postgres;


--
-- Name: TABLE saml_providers; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.saml_providers TO postgres;
GRANT SELECT ON TABLE auth.saml_providers TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.saml_providers TO dashboard_user;


--
-- Name: TABLE saml_relay_states; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.saml_relay_states TO postgres;
GRANT SELECT ON TABLE auth.saml_relay_states TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.saml_relay_states TO dashboard_user;


--
-- Name: TABLE schema_migrations; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT SELECT ON TABLE auth.schema_migrations TO postgres WITH GRANT OPTION;


--
-- Name: TABLE scim_tokens; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.scim_tokens TO postgres;
GRANT ALL ON TABLE auth.scim_tokens TO dashboard_user;


--
-- Name: TABLE scim_users; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.scim_users TO postgres;
GRANT ALL ON TABLE auth.scim_users TO dashboard_user;


--
-- Name: TABLE sessions; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.sessions TO postgres;
GRANT SELECT ON TABLE auth.sessions TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.sessions TO dashboard_user;


--
-- Name: TABLE sso_domains; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.sso_domains TO postgres;
GRANT SELECT ON TABLE auth.sso_domains TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.sso_domains TO dashboard_user;


--
-- Name: TABLE sso_providers; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.sso_providers TO postgres;
GRANT SELECT ON TABLE auth.sso_providers TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.sso_providers TO dashboard_user;


--
-- Name: TABLE users; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.users TO dashboard_user;
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.users TO postgres;
GRANT SELECT ON TABLE auth.users TO postgres WITH GRANT OPTION;


--
-- Name: TABLE webauthn_challenges; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.webauthn_challenges TO postgres;
GRANT ALL ON TABLE auth.webauthn_challenges TO dashboard_user;


--
-- Name: TABLE webauthn_credentials; Type: ACL; Schema: auth; Owner: supabase_auth_admin
--

GRANT ALL ON TABLE auth.webauthn_credentials TO postgres;
GRANT ALL ON TABLE auth.webauthn_credentials TO dashboard_user;


--
-- Name: TABLE app_settings; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.app_settings TO anon;
GRANT ALL ON TABLE public.app_settings TO authenticated;
GRANT ALL ON TABLE public.app_settings TO service_role;


--
-- Name: TABLE bsm_contract_rates; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.bsm_contract_rates TO anon;
GRANT ALL ON TABLE public.bsm_contract_rates TO authenticated;
GRANT ALL ON TABLE public.bsm_contract_rates TO service_role;


--
-- Name: TABLE bsm_contractor_rates; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.bsm_contractor_rates TO anon;
GRANT ALL ON TABLE public.bsm_contractor_rates TO authenticated;
GRANT ALL ON TABLE public.bsm_contractor_rates TO service_role;


--
-- Name: TABLE bsm_supply_rates; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.bsm_supply_rates TO anon;
GRANT ALL ON TABLE public.bsm_supply_rates TO authenticated;
GRANT ALL ON TABLE public.bsm_supply_rates TO service_role;


--
-- Name: TABLE client_errors; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.client_errors TO service_role;
GRANT SELECT ON TABLE public.client_errors TO authenticated;


--
-- Name: SEQUENCE client_errors_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.client_errors_id_seq TO anon;
GRANT ALL ON SEQUENCE public.client_errors_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.client_errors_id_seq TO service_role;


--
-- Name: TABLE client_versions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.client_versions TO service_role;
GRANT SELECT ON TABLE public.client_versions TO authenticated;


--
-- Name: TABLE contacts; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.contacts TO anon;
GRANT ALL ON TABLE public.contacts TO authenticated;
GRANT ALL ON TABLE public.contacts TO service_role;


--
-- Name: TABLE contract_advance_schedule; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.contract_advance_schedule TO anon;
GRANT ALL ON TABLE public.contract_advance_schedule TO authenticated;
GRANT ALL ON TABLE public.contract_advance_schedule TO service_role;


--
-- Name: TABLE contract_appendices; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.contract_appendices TO anon;
GRANT ALL ON TABLE public.contract_appendices TO authenticated;
GRANT ALL ON TABLE public.contract_appendices TO service_role;


--
-- Name: TABLE contract_attachments; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.contract_attachments TO anon;
GRANT ALL ON TABLE public.contract_attachments TO authenticated;
GRANT ALL ON TABLE public.contract_attachments TO service_role;


--
-- Name: TABLE contract_audit_log; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.contract_audit_log TO anon;
GRANT ALL ON TABLE public.contract_audit_log TO authenticated;
GRANT ALL ON TABLE public.contract_audit_log TO service_role;


--
-- Name: TABLE contract_clause_comments; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.contract_clause_comments TO anon;
GRANT ALL ON TABLE public.contract_clause_comments TO authenticated;
GRANT ALL ON TABLE public.contract_clause_comments TO service_role;


--
-- Name: TABLE contract_clause_dispute_clauses; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.contract_clause_dispute_clauses TO anon;
GRANT ALL ON TABLE public.contract_clause_dispute_clauses TO authenticated;
GRANT ALL ON TABLE public.contract_clause_dispute_clauses TO service_role;


--
-- Name: TABLE contract_clause_disputes; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.contract_clause_disputes TO anon;
GRANT ALL ON TABLE public.contract_clause_disputes TO authenticated;
GRANT ALL ON TABLE public.contract_clause_disputes TO service_role;


--
-- Name: TABLE contract_clauses; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.contract_clauses TO anon;
GRANT ALL ON TABLE public.contract_clauses TO authenticated;
GRANT ALL ON TABLE public.contract_clauses TO service_role;


--
-- Name: TABLE contract_counterparties; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.contract_counterparties TO anon;
GRANT ALL ON TABLE public.contract_counterparties TO authenticated;
GRANT ALL ON TABLE public.contract_counterparties TO service_role;


--
-- Name: TABLE contract_psdc_items; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.contract_psdc_items TO anon;
GRANT ALL ON TABLE public.contract_psdc_items TO authenticated;
GRANT ALL ON TABLE public.contract_psdc_items TO service_role;


--
-- Name: SEQUENCE contracts_display_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.contracts_display_id_seq TO anon;
GRANT ALL ON SEQUENCE public.contracts_display_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.contracts_display_id_seq TO service_role;


--
-- Name: TABLE counterparties; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.counterparties TO anon;
GRANT ALL ON TABLE public.counterparties TO authenticated;
GRANT ALL ON TABLE public.counterparties TO service_role;


--
-- Name: TABLE counterparties_inn_backup_2026_09_21; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.counterparties_inn_backup_2026_09_21 TO anon;
GRANT ALL ON TABLE public.counterparties_inn_backup_2026_09_21 TO authenticated;
GRANT ALL ON TABLE public.counterparties_inn_backup_2026_09_21 TO service_role;


--
-- Name: TABLE counterparty_audit_log; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.counterparty_audit_log TO anon;
GRANT ALL ON TABLE public.counterparty_audit_log TO authenticated;
GRANT ALL ON TABLE public.counterparty_audit_log TO service_role;


--
-- Name: TABLE counterparty_contacts; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.counterparty_contacts TO anon;
GRANT ALL ON TABLE public.counterparty_contacts TO authenticated;
GRANT ALL ON TABLE public.counterparty_contacts TO service_role;


--
-- Name: TABLE counterparty_relations; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.counterparty_relations TO anon;
GRANT ALL ON TABLE public.counterparty_relations TO authenticated;
GRANT ALL ON TABLE public.counterparty_relations TO service_role;


--
-- Name: TABLE dc_request_audit_log; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.dc_request_audit_log TO anon;
GRANT ALL ON TABLE public.dc_request_audit_log TO authenticated;
GRANT ALL ON TABLE public.dc_request_audit_log TO service_role;


--
-- Name: TABLE dc_request_tasks; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.dc_request_tasks TO anon;
GRANT ALL ON TABLE public.dc_request_tasks TO authenticated;
GRANT ALL ON TABLE public.dc_request_tasks TO service_role;


--
-- Name: TABLE dc_requests; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.dc_requests TO anon;
GRANT ALL ON TABLE public.dc_requests TO authenticated;
GRANT ALL ON TABLE public.dc_requests TO service_role;


--
-- Name: TABLE departments; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.departments TO anon;
GRANT ALL ON TABLE public.departments TO authenticated;
GRANT ALL ON TABLE public.departments TO service_role;


--
-- Name: TABLE doc_check_request_audit_log; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.doc_check_request_audit_log TO anon;
GRANT ALL ON TABLE public.doc_check_request_audit_log TO authenticated;
GRANT ALL ON TABLE public.doc_check_request_audit_log TO service_role;


--
-- Name: TABLE doc_check_requests; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.doc_check_requests TO anon;
GRANT ALL ON TABLE public.doc_check_requests TO authenticated;
GRANT ALL ON TABLE public.doc_check_requests TO service_role;


--
-- Name: TABLE document_check_requests; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.document_check_requests TO anon;
GRANT ALL ON TABLE public.document_check_requests TO authenticated;
GRANT ALL ON TABLE public.document_check_requests TO service_role;


--
-- Name: TABLE user_roles; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.user_roles TO anon;
GRANT ALL ON TABLE public.user_roles TO authenticated;
GRANT ALL ON TABLE public.user_roles TO service_role;


--
-- Name: TABLE employee_directory; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.employee_directory TO authenticated;
GRANT ALL ON TABLE public.employee_directory TO service_role;


--
-- Name: TABLE employees; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.employees TO anon;
GRANT ALL ON TABLE public.employees TO authenticated;
GRANT ALL ON TABLE public.employees TO service_role;


--
-- Name: TABLE general_document_folders; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.general_document_folders TO anon;
GRANT ALL ON TABLE public.general_document_folders TO authenticated;
GRANT ALL ON TABLE public.general_document_folders TO service_role;


--
-- Name: TABLE general_document_links; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.general_document_links TO anon;
GRANT ALL ON TABLE public.general_document_links TO authenticated;
GRANT ALL ON TABLE public.general_document_links TO service_role;


--
-- Name: TABLE general_documents; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.general_documents TO anon;
GRANT ALL ON TABLE public.general_documents TO authenticated;
GRANT ALL ON TABLE public.general_documents TO service_role;


--
-- Name: TABLE objects; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.objects TO anon;
GRANT ALL ON TABLE public.objects TO authenticated;
GRANT ALL ON TABLE public.objects TO service_role;


--
-- Name: TABLE tender_counterparty_proposals; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tender_counterparty_proposals TO anon;
GRANT ALL ON TABLE public.tender_counterparty_proposals TO authenticated;
GRANT ALL ON TABLE public.tender_counterparty_proposals TO service_role;


--
-- Name: TABLE tender_estimate_items; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tender_estimate_items TO anon;
GRANT ALL ON TABLE public.tender_estimate_items TO authenticated;
GRANT ALL ON TABLE public.tender_estimate_items TO service_role;


--
-- Name: SEQUENCE tenders_public_number_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.tenders_public_number_seq TO anon;
GRANT ALL ON SEQUENCE public.tenders_public_number_seq TO authenticated;
GRANT ALL ON SEQUENCE public.tenders_public_number_seq TO service_role;


--
-- Name: TABLE tenders; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tenders TO anon;
GRANT ALL ON TABLE public.tenders TO authenticated;
GRANT ALL ON TABLE public.tenders TO service_role;


--
-- Name: TABLE kp_rates_registry_mv; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.kp_rates_registry_mv TO authenticated;
GRANT ALL ON TABLE public.kp_rates_registry_mv TO service_role;


--
-- Name: TABLE kp_rates_registry; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.kp_rates_registry TO authenticated;
GRANT ALL ON TABLE public.kp_rates_registry TO service_role;


--
-- Name: TABLE kp_rates_registry_filter_counterparties; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.kp_rates_registry_filter_counterparties TO authenticated;
GRANT ALL ON TABLE public.kp_rates_registry_filter_counterparties TO service_role;


--
-- Name: TABLE kp_rates_registry_filter_objects; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.kp_rates_registry_filter_objects TO authenticated;
GRANT ALL ON TABLE public.kp_rates_registry_filter_objects TO service_role;


--
-- Name: TABLE kp_rates_registry_filter_tenders; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.kp_rates_registry_filter_tenders TO authenticated;
GRANT ALL ON TABLE public.kp_rates_registry_filter_tenders TO service_role;


--
-- Name: TABLE kp_rates_registry_units; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.kp_rates_registry_units TO authenticated;
GRANT ALL ON TABLE public.kp_rates_registry_units TO service_role;


--
-- Name: TABLE object_areas; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.object_areas TO anon;
GRANT ALL ON TABLE public.object_areas TO authenticated;
GRANT ALL ON TABLE public.object_areas TO service_role;


--
-- Name: TABLE object_contract_attachments; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.object_contract_attachments TO anon;
GRANT ALL ON TABLE public.object_contract_attachments TO authenticated;
GRANT ALL ON TABLE public.object_contract_attachments TO service_role;


--
-- Name: TABLE object_cost_plan; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.object_cost_plan TO anon;
GRANT ALL ON TABLE public.object_cost_plan TO authenticated;
GRANT ALL ON TABLE public.object_cost_plan TO service_role;


--
-- Name: TABLE object_documents; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.object_documents TO anon;
GRANT ALL ON TABLE public.object_documents TO authenticated;
GRANT ALL ON TABLE public.object_documents TO service_role;


--
-- Name: TABLE object_estimate_items; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.object_estimate_items TO anon;
GRANT ALL ON TABLE public.object_estimate_items TO authenticated;
GRANT ALL ON TABLE public.object_estimate_items TO service_role;


--
-- Name: TABLE object_staff; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.object_staff TO anon;
GRANT ALL ON TABLE public.object_staff TO authenticated;
GRANT ALL ON TABLE public.object_staff TO service_role;


--
-- Name: TABLE object_warranties; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.object_warranties TO anon;
GRANT ALL ON TABLE public.object_warranties TO authenticated;
GRANT ALL ON TABLE public.object_warranties TO service_role;


--
-- Name: TABLE object_warranty_retention_payments; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.object_warranty_retention_payments TO anon;
GRANT ALL ON TABLE public.object_warranty_retention_payments TO authenticated;
GRANT ALL ON TABLE public.object_warranty_retention_payments TO service_role;


--
-- Name: TABLE object_warranty_retentions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.object_warranty_retentions TO anon;
GRANT ALL ON TABLE public.object_warranty_retentions TO authenticated;
GRANT ALL ON TABLE public.object_warranty_retentions TO service_role;


--
-- Name: TABLE positions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.positions TO anon;
GRANT ALL ON TABLE public.positions TO authenticated;
GRANT ALL ON TABLE public.positions TO service_role;


--
-- Name: TABLE psdc; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.psdc TO authenticated;
GRANT ALL ON TABLE public.psdc TO service_role;


--
-- Name: TABLE psdc_batches; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.psdc_batches TO authenticated;
GRANT ALL ON TABLE public.psdc_batches TO service_role;


--
-- Name: TABLE psdc_issues; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.psdc_issues TO authenticated;
GRANT ALL ON TABLE public.psdc_issues TO service_role;


--
-- Name: SEQUENCE psdc_issues_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.psdc_issues_id_seq TO anon;
GRANT ALL ON SEQUENCE public.psdc_issues_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.psdc_issues_id_seq TO service_role;


--
-- Name: TABLE psdc_rows; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.psdc_rows TO authenticated;
GRANT ALL ON TABLE public.psdc_rows TO service_role;


--
-- Name: TABLE psdc_source_rows; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.psdc_source_rows TO authenticated;
GRANT ALL ON TABLE public.psdc_source_rows TO service_role;


--
-- Name: TABLE role_permissions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.role_permissions TO anon;
GRANT ALL ON TABLE public.role_permissions TO authenticated;
GRANT ALL ON TABLE public.role_permissions TO service_role;


--
-- Name: TABLE roles; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.roles TO anon;
GRANT ALL ON TABLE public.roles TO authenticated;
GRANT ALL ON TABLE public.roles TO service_role;


--
-- Name: TABLE s3_documents; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.s3_documents TO anon;
GRANT ALL ON TABLE public.s3_documents TO authenticated;
GRANT ALL ON TABLE public.s3_documents TO service_role;


--
-- Name: TABLE tender_vor_supply_rates; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tender_vor_supply_rates TO anon;
GRANT ALL ON TABLE public.tender_vor_supply_rates TO authenticated;
GRANT ALL ON TABLE public.tender_vor_supply_rates TO service_role;


--
-- Name: TABLE supply_rates_registry_mv; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.supply_rates_registry_mv TO authenticated;
GRANT ALL ON TABLE public.supply_rates_registry_mv TO service_role;


--
-- Name: TABLE supply_rates_registry; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.supply_rates_registry TO authenticated;
GRANT ALL ON TABLE public.supply_rates_registry TO service_role;


--
-- Name: TABLE supply_rates_registry_filter_objects; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.supply_rates_registry_filter_objects TO authenticated;
GRANT ALL ON TABLE public.supply_rates_registry_filter_objects TO service_role;


--
-- Name: TABLE supply_rates_registry_filter_tenders; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.supply_rates_registry_filter_tenders TO authenticated;
GRANT ALL ON TABLE public.supply_rates_registry_filter_tenders TO service_role;


--
-- Name: TABLE supply_rates_registry_units; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.supply_rates_registry_units TO authenticated;
GRANT ALL ON TABLE public.supply_rates_registry_units TO service_role;


--
-- Name: TABLE task_audit_log; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.task_audit_log TO anon;
GRANT ALL ON TABLE public.task_audit_log TO authenticated;
GRANT ALL ON TABLE public.task_audit_log TO service_role;


--
-- Name: TABLE task_checklist_items; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.task_checklist_items TO anon;
GRANT ALL ON TABLE public.task_checklist_items TO authenticated;
GRANT ALL ON TABLE public.task_checklist_items TO service_role;


--
-- Name: TABLE task_comments; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.task_comments TO anon;
GRANT ALL ON TABLE public.task_comments TO authenticated;
GRANT ALL ON TABLE public.task_comments TO service_role;


--
-- Name: TABLE task_participants; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.task_participants TO anon;
GRANT ALL ON TABLE public.task_participants TO authenticated;
GRANT ALL ON TABLE public.task_participants TO service_role;


--
-- Name: TABLE tasks; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tasks TO anon;
GRANT ALL ON TABLE public.tasks TO authenticated;
GRANT ALL ON TABLE public.tasks TO service_role;


--
-- Name: TABLE tender_audit_log; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tender_audit_log TO anon;
GRANT ALL ON TABLE public.tender_audit_log TO authenticated;
GRANT ALL ON TABLE public.tender_audit_log TO service_role;


--
-- Name: TABLE tender_counterparties; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tender_counterparties TO anon;
GRANT ALL ON TABLE public.tender_counterparties TO authenticated;
GRANT ALL ON TABLE public.tender_counterparties TO service_role;


--
-- Name: TABLE tender_doc_links; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tender_doc_links TO anon;
GRANT ALL ON TABLE public.tender_doc_links TO authenticated;
GRANT ALL ON TABLE public.tender_doc_links TO service_role;


--
-- Name: TABLE tender_docs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tender_docs TO anon;
GRANT ALL ON TABLE public.tender_docs TO authenticated;
GRANT ALL ON TABLE public.tender_docs TO service_role;


--
-- Name: TABLE tender_documents; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tender_documents TO anon;
GRANT ALL ON TABLE public.tender_documents TO authenticated;
GRANT ALL ON TABLE public.tender_documents TO service_role;


--
-- Name: TABLE tender_proposal_files; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tender_proposal_files TO anon;
GRANT ALL ON TABLE public.tender_proposal_files TO authenticated;
GRANT ALL ON TABLE public.tender_proposal_files TO service_role;


--
-- Name: TABLE tender_rd_codes; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tender_rd_codes TO anon;
GRANT ALL ON TABLE public.tender_rd_codes TO authenticated;
GRANT ALL ON TABLE public.tender_rd_codes TO service_role;


--
-- Name: TABLE tender_rd_document_codes; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tender_rd_document_codes TO anon;
GRANT ALL ON TABLE public.tender_rd_document_codes TO authenticated;
GRANT ALL ON TABLE public.tender_rd_document_codes TO service_role;


--
-- Name: TABLE tender_winners; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tender_winners TO anon;
GRANT ALL ON TABLE public.tender_winners TO authenticated;
GRANT ALL ON TABLE public.tender_winners TO service_role;


--
-- Name: TABLE vor_requests; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.vor_requests TO authenticated;
GRANT ALL ON TABLE public.vor_requests TO service_role;


--
-- Name: SEQUENCE vor_requests_number_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.vor_requests_number_seq TO anon;
GRANT ALL ON SEQUENCE public.vor_requests_number_seq TO authenticated;
GRANT ALL ON SEQUENCE public.vor_requests_number_seq TO service_role;


--
-- Name: TABLE work_types; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.work_types TO anon;
GRANT ALL ON TABLE public.work_types TO authenticated;
GRANT ALL ON TABLE public.work_types TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: auth; Owner: supabase_auth_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON SEQUENCES TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: auth; Owner: supabase_auth_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON FUNCTIONS TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: auth; Owner: supabase_auth_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON TABLES TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict EMAUI6767DCT6AtdVJNjnJWdHCdfQtCdQwcz0pJbvprL2pnXJpGueNJk5F4L9Vb

