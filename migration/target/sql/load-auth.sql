-- Учётные записи Supabase Auth с отпечатками паролей (load.sh --auth, та же транзакция загрузки):
-- вход потом переходит в Keycloak, и пароли пользователей должны остаться прежними.
-- Закрытая схема osp_vault. Порталу и шлюзу она не нужна и недоступна:
--   • PostgREST отдаёт только схему public; в списке шлюза (allow.json) её нет;
--   • правило по строкам действует и на владельца (FORCE): читать и писать можно только с отметкой
--     application_name = 'osp:vault' внутри транзакции. Её не ставит ни одна функция портала — только
--     инструменты переноса (эта загрузка, verify.sh, vault.sh и заполнение копии auth.users в
--     load-single-owner.sql);
--   • ни одно представление и ни одна функция схемы public на неё не ссылаются (rights-check.sql).
-- Чего это не закрывает: учётка базы одна на портал и соседние системы, и её владелец может поставить
-- отметку сам. Отпечатки защищены так же, как все данные портала, — паролем этой учётки.
-- Одноразовые коды из писем и сессии сюда не попадают: их нет в выгрузке (migration/backup/extras.sql).
-- Переменные psql: auth_copy_file (\copy из выгрузок, lib/extras.mjs), auth_users_expected и
-- auth_identities_expected (числа из описи копии), auth_users_sha256, auth_identities_sha256, source_name.
CREATE SCHEMA osp_vault;
COMMENT ON SCHEMA osp_vault IS 'Учётные записи Supabase Auth с отпечатками паролей — для перехода входа в Keycloak (migration/target). Закрыто: только с отметкой osp:vault.';
REVOKE ALL ON SCHEMA osp_vault FROM PUBLIC;

-- Колонки и типы — как в auth.users Supabase, без одноразовых кодов.
CREATE TABLE osp_vault.users (
  id uuid PRIMARY KEY,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_sent_at timestamptz,
  recovery_sent_at timestamptz,
  email_change varchar(255),
  email_change_sent_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz,
  updated_at timestamptz,
  phone text,
  phone_confirmed_at timestamptz,
  phone_change text,
  phone_change_sent_at timestamptz,
  email_change_confirm_status smallint,
  banned_until timestamptz,
  reauthentication_sent_at timestamptz,
  is_sso_user boolean,
  deleted_at timestamptz,
  is_anonymous boolean
);
CREATE TABLE osp_vault.identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES osp_vault.users (id),
  provider text NOT NULL,
  provider_id text,
  identity_data jsonb NOT NULL,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
);
-- Когда и из какой копии сняты отпечатки: кто сменит пароль позже, у того отпечаток устарел (vault.sh status).
CREATE TABLE osp_vault.copy_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_name text NOT NULL,
  users_sha256 text NOT NULL CHECK (users_sha256 ~ '^[0-9a-f]{64}$'),
  identities_sha256 text NOT NULL CHECK (identities_sha256 ~ '^[0-9a-f]{64}$'),
  users integer NOT NULL,
  identities integer NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

\i :auth_copy_file

INSERT INTO osp_vault.copy_log (source_name, users_sha256, identities_sha256, users, identities)
SELECT :'source_name', :'auth_users_sha256', :'auth_identities_sha256',
       (SELECT pg_catalog.count(*) FROM osp_vault.users), (SELECT pg_catalog.count(*) FROM osp_vault.identities);
SELECT pg_catalog.set_config('osp.vault_expected', :'auth_users_expected' || '/' || :'auth_identities_expected', true);

DO $vault$
DECLARE
  v_expected text := pg_catalog.current_setting('osp.vault_expected');
  v_got text;
  t text;
BEGIN
  SELECT users || '/' || identities INTO v_got FROM osp_vault.copy_log;
  -- Числа из описи копии сняты в той же транзакции, что и выгрузки: не совпали — файл недописан.
  IF v_got IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'OSP_VAULT_COUNT: загружено учёток/способов входа %, в описи копии %', v_got, v_expected;
  END IF;
  FOREACH t IN ARRAY ARRAY['users', 'identities', 'copy_log'] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE osp_vault.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE pg_catalog.format('ALTER TABLE osp_vault.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE pg_catalog.format($p$CREATE POLICY osp_vault_only ON osp_vault.%I FOR ALL TO PUBLIC
      USING (pg_catalog.current_setting('application_name', true) = 'osp:vault')
      WITH CHECK (pg_catalog.current_setting('application_name', true) = 'osp:vault')$p$, t);
  END LOOP;
END
$vault$;
