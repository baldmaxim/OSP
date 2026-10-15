-- Свой вход портала tender.su10.ru вместо Supabase Auth (migration/CUTOVER.md, «Свой вход tender.su10.ru»).
-- Учётки остаются в auth.users (те же идентификаторы), пароли и сессии — в двух закрытых схемах.
--
-- osp_auth — пароли, неудачные входы, надгробия удалённых учёток, журнал входа. Читается и пишется
--   ТОЛЬКО в транзакции с отметкой application_name = 'osp:auth': её ставят модуль входа osp-api
--   (server/osp-api/src/lib/auth/) и инструмент переноса учёток (migration/accounts/). Пропуск служебных
--   функций (osp:internal) и служебный ключ эти таблицы не открывают; ни одна функция базы на схему не
--   ссылается (правило 12 в migration/target/sql/rights-check-body.sql).
--   Отпечатки паролей в credentials зашифрованы ключом сервера (OSP_AUTH_KEYS): строка базы, её копия и
--   выгрузка сами по себе отпечатка для перебора не дают.
-- osp_session — сессии входа: пропуск служебных функций, как у auth.users. Данные временные — копия базы
--   (migration/target/export.sh) берёт только структуру.
--
-- Полноту учёток (каждый пользователь портала есть в auth.users) эта миграция не проверяет: учётки
-- дозаполняет migration/accounts/accounts-sync, а включение своего входа требует свежего accounts-check.

CREATE SCHEMA IF NOT EXISTS osp_auth;
REVOKE ALL ON SCHEMA osp_auth FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS osp_session;
REVOKE ALL ON SCHEMA osp_session FROM PUBLIC;

-- Нормализация почты — одна на всё: уникальный индекс, вход, перенос учёток. В коде сервера почта не
-- нормализуется: везде вызывается эта функция.
CREATE OR REPLACE FUNCTION osp_private.email_norm(p_email text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT pg_catalog.lower(pg_catalog.btrim(p_email)) $$;

-- Одна почта — одна учётка. Дубли (после нормализации) — миграция откатывается целиком.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_norm_key ON auth.users (osp_private.email_norm(email)) WHERE email IS NOT NULL;

-- Пароли. secret — «v1:<ключ>:<base64(iv|шифр|тег)>», внутри шифра — строка отпечатка:
-- «$scrypt$ln=15,r=8,p=3$<соль>$<ключ>» (свой) или исходный bcrypt из Supabase. version растёт при любой
-- смене: вход создаёт сессию, только если версия та же, что была проверена.
CREATE TABLE IF NOT EXISTS osp_auth.credentials (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  secret text NOT NULL CHECK (secret ~ '^v1:[a-z0-9]{1,16}:[A-Za-z0-9+/]+={0,2}$'),
  version bigint NOT NULL DEFAULT 1,
  algo text NOT NULL CHECK (algo IN ('bcrypt', 'scrypt')),
  source text NOT NULL CHECK (source IN ('supabase', 'own')),
  must_change boolean NOT NULL DEFAULT false,
  supabase_sha256 text CHECK (supabase_sha256 ~ '^[0-9a-f]{64}$'),
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- Неудачные входы по нормализованной почте (в том числе несуществующей — по ответу нельзя понять, есть ли
-- учётка). Вытесняются только строки несуществующих почт без действующей блокировки.
CREATE TABLE IF NOT EXISTS osp_auth.login_failures (
  email_norm text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  locked_until timestamptz,
  last_at timestamptz NOT NULL DEFAULT now(),
  account_exists boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS login_failures_last_at_idx ON osp_auth.login_failures (last_at);

-- Учётки, удалённые администратором в новом портале: повторный перенос из Supabase их не воссоздаёт.
-- Внешнего ключа на auth.users нет намеренно — строка переживает удаление учётки.
CREATE TABLE IF NOT EXISTS osp_auth.tombstones (
  user_id uuid PRIMARY KEY,
  email_norm text,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_by uuid
);

-- Журнал входа: вход, неудача, блокировка, смена и сброс пароля, создание учётки. Без паролей и без
-- идентификаторов сессий. Хранится 180 дней.
CREATE TABLE IF NOT EXISTS osp_auth.events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS events_at_idx ON osp_auth.events (at);

-- Канарейка ключа сервера и отметки переноса учёток.
CREATE TABLE IF NOT EXISTS osp_auth.meta (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $osp_auth_rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['credentials', 'login_failures', 'tombstones', 'events', 'meta'] LOOP
    EXECUTE format('ALTER TABLE osp_auth.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE osp_auth.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS osp_auth_only ON osp_auth.%I', t);
    EXECUTE format($p$CREATE POLICY osp_auth_only ON osp_auth.%I FOR ALL TO PUBLIC
      USING (current_setting('application_name', true) = 'osp:auth')
      WITH CHECK (current_setting('application_name', true) = 'osp:auth')$p$, t);
  END LOOP;
END
$osp_auth_rls$;

-- Сессии. В cookie — случайный идентификатор, здесь — только его sha256.
CREATE TABLE IF NOT EXISTS osp_session.sessions (
  id_hash text PRIMARY KEY CHECK (id_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  csrf text NOT NULL,
  must_change boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text
);
CREATE INDEX IF NOT EXISTS sessions_user_live_idx ON osp_session.sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_absolute_idx ON osp_session.sessions (absolute_expires_at);
ALTER TABLE osp_session.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE osp_session.sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osp_internal ON osp_session.sessions;
CREATE POLICY osp_internal ON osp_session.sessions FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Блокировка и снятие одобрения отзывают сессии сразу — и когда администратор меняет строку user_roles
-- напрямую (AdminPage), минуя модуль входа. Функция служебная: отметка пропуска только на время работы.
CREATE OR REPLACE FUNCTION osp_private.revoke_user_sessions() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog
  SET application_name = 'osp:internal'
AS $$
BEGIN
  UPDATE osp_session.sessions
     SET revoked_at = now(), revoke_reason = CASE TG_OP WHEN 'DELETE' THEN 'roles_deleted' ELSE 'status' END
   WHERE user_id = OLD.user_id AND revoked_at IS NULL;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION osp_private.revoke_user_sessions() FROM PUBLIC;

DROP TRIGGER IF EXISTS user_roles_revoke_sessions ON public.user_roles;
CREATE TRIGGER user_roles_revoke_sessions AFTER UPDATE OF is_blocked, is_approved ON public.user_roles
  FOR EACH ROW WHEN ((NEW.is_blocked AND NOT OLD.is_blocked) OR (OLD.is_approved AND NOT NEW.is_approved))
  EXECUTE FUNCTION osp_private.revoke_user_sessions();
DROP TRIGGER IF EXISTS user_roles_revoke_sessions_delete ON public.user_roles;
CREATE TRIGGER user_roles_revoke_sessions_delete AFTER DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION osp_private.revoke_user_sessions();
