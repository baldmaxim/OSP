-- Организация подрядчика по учётке СУ-10 (вход через Keycloak, server/osp-api/src/lib/auth/orgs.js; migration/CUTOVER.md).
-- Только база Яндекса: прежний портал (osp.root.sx) входит через Supabase.
--
-- auth.su10.ru ведёт реестр организаций (подгруппы /org/… realm su10) и кладёт в access token claim su10_org_id. Портал
-- держит связь «организация СУ-10 → контрагент» строго 1:1 и по ней сам ставит user_roles.counterparty_id подрядчику.
-- Ошибка связи открыла бы чужую историю контрагента, поэтому:
--   • связь ставит только администратор (osp-api, маршруты /api/admin/su10-orgs*), автоматической пакетной связи нет;
--   • связь действует, только пока организация в реестре действует (state = 'active') и это подрядчик;
--   • контрагента подрядчика мимо сервера не поменять: колонка user_roles.counterparty_source и запрет в базе;
--   • любая смена контрагента учётки, чёрный список и удаление контрагента сразу закрывают сессии (триггеры ниже).
--
-- Что добавляет (только добавляет — существующие строки не меняются):
--   osp_auth.su10_orgs      — кэш реестра организаций СУ-10 с состоянием (active | missing | invalid) и поколением сверки;
--   osp_auth.org_links      — связь (issuer, su10_org_id) → counterparties.id, 1:1; удалить связанного контрагента нельзя;
--   osp_auth.subject_orgs   — организация учётки СУ-10 и членство в группе доступа: только для показа администратору,
--                             решения о доступе по ней не принимаются (решает claim токена);
--   osp_auth.org_exceptions — сотрудники, допущенные суперадминистратором при «не своей» организации (с причиной);
--   user_roles.counterparty_source = 'su10' — контрагента поставил сервер по организации СУ-10;
--   триггеры: запрет правки такого контрагента мимо сервера; отзыв сессий при смене контрагента или роли «подрядчик»;
--   отзыв сессий подрядчиков контрагента, переведённого в чёрный список или удалённого.
--
-- osp_auth — как пароли и связи учёток: только с отметкой application_name = 'osp:auth' (модуль входа osp-api). Ни одна
-- функция базы на osp_auth не ссылается (правило 12 проверки прав).

-- ── 1. Реестр организаций СУ-10 (кэш) ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS osp_auth.su10_orgs (
  issuer text NOT NULL CHECK (issuer ~ '^https://[^[:space:]]+$' AND char_length(issuer) <= 300),
  su10_org_id uuid NOT NULL,
  kind text CHECK (kind IN ('own', 'contractor')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 300),
  inn text CHECK (inn ~ '^([0-9]{10}|[0-9]{12})$'),
  state text NOT NULL CHECK (state IN ('active', 'missing', 'invalid')),
  invalid_reason text CHECK (invalid_reason IN ('duplicate_id', 'attributes')),
  generation bigint NOT NULL CHECK (generation > 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz NOT NULL DEFAULT now(),
  missing_since timestamptz,
  PRIMARY KEY (issuer, su10_org_id),
  -- Действующая — всегда с видом; причина ошибки — только у ошибочной; «с какого времени нет» — только у пропавшей.
  CONSTRAINT su10_orgs_state_fields CHECK (
    (state <> 'active' OR kind IS NOT NULL)
    AND ((state = 'invalid') = (invalid_reason IS NOT NULL))
    AND ((state = 'missing') = (missing_since IS NOT NULL)))
);

-- ── 2. Связь организации с контрагентом (1:1) ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS osp_auth.org_links (
  issuer text NOT NULL CHECK (issuer ~ '^https://[^[:space:]]+$' AND char_length(issuer) <= 300),
  su10_org_id uuid NOT NULL,
  counterparty_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('bulk', 'admin')),
  match text NOT NULL CHECK (match IN ('inn', 'admin')),
  linked_by uuid,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, su10_org_id),
  CONSTRAINT org_links_counterparty_key UNIQUE (issuer, counterparty_id),
  -- Связать можно только организацию, которую сервер видел в реестре.
  CONSTRAINT org_links_org_fkey FOREIGN KEY (issuer, su10_org_id)
    REFERENCES osp_auth.su10_orgs (issuer, su10_org_id) ON DELETE RESTRICT,
  -- Контрагента, с которым связана организация, удалить нельзя: сначала снять связь.
  CONSTRAINT org_links_counterparty_fkey FOREIGN KEY (counterparty_id)
    REFERENCES public.counterparties (id) ON DELETE RESTRICT,
  -- Решение администратора — всегда с автором.
  CONSTRAINT org_links_admin_author CHECK (source <> 'admin' OR linked_by IS NOT NULL)
);

-- ── 3. Организация учётки СУ-10 (для показа) ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS osp_auth.subject_orgs (
  issuer text NOT NULL CHECK (issuer ~ '^https://[^[:space:]]+$' AND char_length(issuer) <= 300),
  subject uuid NOT NULL,
  org_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(org_ids) <= 10),
  org_source text CHECK (org_source IN ('token', 'admin_api')),
  org_seen_at timestamptz,
  in_group boolean NOT NULL DEFAULT false,
  group_seen_at timestamptz,
  PRIMARY KEY (issuer, subject),
  CONSTRAINT subject_orgs_source_fields CHECK ((org_source IS NULL) = (org_seen_at IS NULL))
);

-- ── 4. Исключения для сотрудников с «не своей» организацией ─────────────────────────────────────────────────────
-- su10_org_id — для какой организации допущен (NULL — учётка без организации). Перевели в другую — исключение не действует.
CREATE TABLE IF NOT EXISTS osp_auth.org_exceptions (
  issuer text NOT NULL CHECK (issuer ~ '^https://[^[:space:]]+$' AND char_length(issuer) <= 300),
  subject uuid NOT NULL,
  su10_org_id uuid,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject)
);

DO $osp_org_rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['su10_orgs', 'org_links', 'subject_orgs', 'org_exceptions'] LOOP
    EXECUTE format('ALTER TABLE osp_auth.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE osp_auth.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS osp_auth_only ON osp_auth.%I', t);
    EXECUTE format($p$CREATE POLICY osp_auth_only ON osp_auth.%I FOR ALL TO PUBLIC
      USING (current_setting('application_name', true) = 'osp:auth')
      WITH CHECK (current_setting('application_name', true) = 'osp:auth')$p$, t);
  END LOOP;
END
$osp_org_rls$;

-- ── 5. Контрагент учётки СУ-10 задаёт только сервер ─────────────────────────────────────────────────────────────
ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS counterparty_source text;
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_counterparty_source_check;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_counterparty_source_check
  CHECK (counterparty_source IS NULL OR (counterparty_source = 'su10' AND counterparty_id IS NOT NULL));
COMMENT ON COLUMN public.user_roles.counterparty_source IS
  '''su10'' — контрагента поставил сервер по организации учётки СУ-10 (osp_auth.org_links); правка мимо сервера запрещена';

-- Без пропуска (запрос через шлюз данных — «Администрирование», прямой запрос) нельзя ни поставить отметку 'su10', ни
-- поменять контрагента у строки с ней. Сервер пишет с отметкой служебной операции. Каскад ON DELETE SET NULL при
-- удалении контрагента тоже упирается сюда — так и задумано: контрагента подрядчиков СУ-10 удалить нельзя.
CREATE OR REPLACE FUNCTION osp_private.user_roles_counterparty_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF (SELECT osp_private.bypass()) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.counterparty_source IS NOT NULL THEN
      RAISE EXCEPTION 'Контрагента учётки СУ-10 задаёт организация — «Администрирование» → «Организации СУ-10»'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.counterparty_source IS DISTINCT FROM OLD.counterparty_source
     OR (OLD.counterparty_source IS NOT NULL AND NEW.counterparty_id IS DISTINCT FROM OLD.counterparty_id) THEN
    RAISE EXCEPTION 'Контрагента учётки СУ-10 задаёт организация — «Администрирование» → «Организации СУ-10»'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION osp_private.user_roles_counterparty_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS user_roles_counterparty_guard ON public.user_roles;
CREATE TRIGGER user_roles_counterparty_guard BEFORE INSERT OR UPDATE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION osp_private.user_roles_counterparty_guard();

-- ── 6. Смена контрагента учётки или переход в роль «подрядчик» и из неё — сессии закрываются сразу ─────────────────
-- Любым путём: сервер (организация СУ-10 сменилась), «Администрирование» через шлюз, каскад удаления контрагента.
-- Функция служебная: отметка пропуска только на время работы (как osp_private.revoke_user_sessions, 20261019).
CREATE OR REPLACE FUNCTION osp_private.user_roles_counterparty_revoke() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog
  SET application_name = 'osp:internal'
AS $$
BEGIN
  UPDATE osp_session.sessions
     SET revoked_at = now(), revoke_reason = 'counterparty_changed'
   WHERE user_id = NEW.user_id AND revoked_at IS NULL;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION osp_private.user_roles_counterparty_revoke() FROM PUBLIC;

DROP TRIGGER IF EXISTS user_roles_counterparty_revoke ON public.user_roles;
CREATE TRIGGER user_roles_counterparty_revoke AFTER UPDATE OF counterparty_id, role ON public.user_roles
  FOR EACH ROW WHEN (NEW.counterparty_id IS DISTINCT FROM OLD.counterparty_id
                     OR (NEW.role = 'contractor') IS DISTINCT FROM (OLD.role = 'contractor'))
  EXECUTE FUNCTION osp_private.user_roles_counterparty_revoke();

-- ── 7. Контрагент в чёрном списке или удалён — сессии его подрядчиков закрываются сразу ───────────────────────────
CREATE OR REPLACE FUNCTION osp_private.counterparties_revoke_sessions() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog
  SET application_name = 'osp:internal'
AS $$
BEGIN
  UPDATE osp_session.sessions s
     SET revoked_at = now(), revoke_reason = 'counterparty_blocked'
   WHERE s.revoked_at IS NULL
     AND s.user_id IN (SELECT ur.user_id FROM public.user_roles ur WHERE ur.counterparty_id = NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION osp_private.counterparties_revoke_sessions() FROM PUBLIC;

DROP TRIGGER IF EXISTS counterparties_revoke_sessions ON public.counterparties;
CREATE TRIGGER counterparties_revoke_sessions AFTER UPDATE OF status, deleted_at ON public.counterparties
  FOR EACH ROW WHEN ((NEW.status::text = 'blacklist' AND OLD.status::text IS DISTINCT FROM 'blacklist')
                     OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL))
  EXECUTE FUNCTION osp_private.counterparties_revoke_sessions();
