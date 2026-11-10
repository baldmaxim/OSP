-- Вход через Keycloak su10 (OIDC, BFF): связи учёток портала с учётками СУ-10, заявки администратору ОСП, сессии
-- нового вида (server/osp-api/src/lib/auth/oidc.js, identity.js; migration/CUTOVER.md, «Вход через Keycloak su10»).
-- Только база Яндекса: прежний портал (osp.root.sx) входит через Supabase, свой вход живёт только здесь.
--
-- Что добавляет (только добавляет — пароли, учётки и прежние сессии не трогаются):
--   osp_auth.identity_links    — связь (issuer, sub СУ-10) → auth.users.id. auth.users.id не меняется: на нём
--                                держатся внешние ключи и правила по строкам (auth.uid());
--   osp_auth.identity_requests — заявки администратору ОСП: человек с доступом к порталу в СУ-10, но без связи;
--   osp_session.sessions       — вид сессии (password | keycloak), refresh и id_token Keycloak (зашифрованы ключом
--                                сервера, AAD — id сессии), аренда перепроверки, время последнего действия;
--   отзыв сессии затирает токены Keycloak — каким бы путём ни отзывали (выход, блокировка, триггеры, чистка);
--   роль «Администратор» выдаёт только суперадминистратор (решение пользователя 10.11.2026): и через шлюз данных
--   (AdminPage пишет user_roles напрямую), и в маршрутах входа. Без вошедшего (служебная операция) — без проверки.
--
-- osp_auth — как пароли: только с отметкой application_name = 'osp:auth' (модуль входа osp-api). Ни одна функция
-- базы на osp_auth не ссылается (правило 12 проверки прав).

CREATE TABLE IF NOT EXISTS osp_auth.identity_links (
  issuer text NOT NULL CHECK (issuer ~ '^https://[^[:space:]]+$' AND char_length(issuer) <= 300),
  subject uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('link_file', 'email', 'request', 'admin')),
  linked_by uuid,
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  PRIMARY KEY (issuer, subject),
  CONSTRAINT identity_links_user_key UNIQUE (issuer, user_id)
);

CREATE TABLE IF NOT EXISTS osp_auth.identity_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer text NOT NULL CHECK (issuer ~ '^https://[^[:space:]]+$' AND char_length(issuer) <= 300),
  subject uuid NOT NULL,
  email text CHECK (char_length(email) <= 254),
  full_name text CHECK (char_length(full_name) <= 200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'linked', 'rejected')),
  origin text NOT NULL CHECK (origin IN ('login', 'kc_sync')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Входы: NULL, пока человек не входил (заявка от сверки группы). Заявку с входами сверка не удаляет никогда.
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  decided_by uuid,
  decided_at timestamptz,
  linked_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT identity_requests_subject_key UNIQUE (issuer, subject)
);
CREATE INDEX IF NOT EXISTS identity_requests_status_idx ON osp_auth.identity_requests (status, created_at);

DO $osp_identity_rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['identity_links', 'identity_requests'] LOOP
    EXECUTE format('ALTER TABLE osp_auth.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE osp_auth.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS osp_auth_only ON osp_auth.%I', t);
    EXECUTE format($p$CREATE POLICY osp_auth_only ON osp_auth.%I FOR ALL TO PUBLIC
      USING (current_setting('application_name', true) = 'osp:auth')
      WITH CHECK (current_setting('application_name', true) = 'osp:auth')$p$, t);
  END LOOP;
END
$osp_identity_rls$;

-- Сессии: вид и поля Keycloak. Прежние строки — парольные (значение по умолчанию), поля Keycloak у них пусты.
ALTER TABLE osp_session.sessions
  ADD COLUMN IF NOT EXISTS auth_source text NOT NULL DEFAULT 'password',
  ADD COLUMN IF NOT EXISTS kc_issuer text,
  ADD COLUMN IF NOT EXISTS kc_subject uuid,
  ADD COLUMN IF NOT EXISTS kc_sid text,
  ADD COLUMN IF NOT EXISTS kc_refresh_enc text,
  ADD COLUMN IF NOT EXISTS kc_id_token_enc text,
  ADD COLUMN IF NOT EXISTS kc_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS kc_check_owner text,
  ADD COLUMN IF NOT EXISTS kc_check_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS kc_retry_after timestamptz,
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

ALTER TABLE osp_session.sessions DROP CONSTRAINT IF EXISTS sessions_auth_source_check;
ALTER TABLE osp_session.sessions ADD CONSTRAINT sessions_auth_source_check CHECK (auth_source IN ('password', 'keycloak'));
-- Парольная сессия не несёт ничего от Keycloak; сессия Keycloak — всегда с issuer, sub и временем проверки, а пока не
-- отозвана — и с refresh token (без него её нельзя перепроверить).
ALTER TABLE osp_session.sessions DROP CONSTRAINT IF EXISTS sessions_kc_fields_check;
ALTER TABLE osp_session.sessions ADD CONSTRAINT sessions_kc_fields_check CHECK (
  CASE auth_source
    WHEN 'password' THEN kc_issuer IS NULL AND kc_subject IS NULL AND kc_sid IS NULL AND kc_refresh_enc IS NULL
      AND kc_id_token_enc IS NULL AND kc_checked_at IS NULL AND kc_check_owner IS NULL AND kc_check_lease_until IS NULL
      AND kc_retry_after IS NULL
    ELSE kc_issuer IS NOT NULL AND kc_subject IS NOT NULL AND kc_checked_at IS NOT NULL
      AND (revoked_at IS NOT NULL OR kc_refresh_enc IS NOT NULL)
  END);
CREATE INDEX IF NOT EXISTS sessions_kc_subject_idx ON osp_session.sessions (kc_issuer, kc_subject)
  WHERE revoked_at IS NULL AND auth_source = 'keycloak';

-- Отзыв сессии затирает токены Keycloak — любым путём: выход, «выйти везде», блокировка (триггер user_roles),
-- сверка группы. Функция не служебная: работает в правах того, кто отзывает.
CREATE OR REPLACE FUNCTION osp_private.sessions_wipe_kc_tokens() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.kc_refresh_enc := NULL;
  NEW.kc_id_token_enc := NULL;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION osp_private.sessions_wipe_kc_tokens() FROM PUBLIC;

DROP TRIGGER IF EXISTS sessions_wipe_kc_tokens ON osp_session.sessions;
CREATE TRIGGER sessions_wipe_kc_tokens BEFORE UPDATE ON osp_session.sessions
  FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL AND (NEW.kc_refresh_enc IS NOT NULL OR NEW.kc_id_token_enc IS NOT NULL))
  EXECUTE FUNCTION osp_private.sessions_wipe_kc_tokens();

-- Роль «Администратор» — только из рук суперадминистратора: новая строка с одобренной ролью admin или перевод в неё
-- (смена роли, одобрение строки с этой ролью). Действующие администраторы остаются. Без вошедшего (служебная операция,
-- перенос учёток) — без проверки: маршруты osp-api проверяют суперадминистратора сами.
CREATE OR REPLACE FUNCTION osp_private.user_roles_admin_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL OR NEW.role IS DISTINCT FROM 'admin' OR NOT coalesce(NEW.is_approved, false) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.role = 'admin' AND coalesce(OLD.is_approved, false) AND OLD.user_id = NEW.user_id THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.superadmins s WHERE s.user_id = v_actor) THEN
    RAISE EXCEPTION 'Роль «Администратор» выдаёт только суперадминистратор' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION osp_private.user_roles_admin_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS user_roles_admin_guard ON public.user_roles;
CREATE TRIGGER user_roles_admin_guard BEFORE INSERT OR UPDATE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION osp_private.user_roles_admin_guard();
