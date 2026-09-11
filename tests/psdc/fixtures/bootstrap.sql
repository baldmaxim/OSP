-- Минимальное окружение Supabase для тестов ПСДЦ на локальном PostgreSQL.
-- Повторяет только то, на что опираются миграции 20260906 и 20260908:
-- роли anon/authenticated, auth.uid(), таблицы договоров, ролей, аудита и S3.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;

CREATE TABLE objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE counterparties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);

CREATE SEQUENCE contracts_display_id_seq;
CREATE TABLE contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_id bigint NOT NULL DEFAULT nextval('contracts_display_id_seq') UNIQUE,
  record_type text NOT NULL DEFAULT 'dp',
  parent_contract_id uuid REFERENCES contracts(id) ON DELETE SET NULL,
  status varchar(20) DEFAULT 'new_request',
  deleted_at timestamptz,
  contract_number text,
  contract_date date,
  object_id uuid REFERENCES objects(id),
  counterparty_id uuid REFERENCES counterparties(id),
  contract_amount numeric(15, 2),
  gp_amount numeric(15, 2),
  currency varchar(3) NOT NULL DEFAULT 'RUB',
  vat_rate numeric(5, 2),
  amount_includes_vat boolean NOT NULL DEFAULT true,
  bsm text,
  work_name text,
  work_start_date date,
  work_end_date date,
  warranty_retention_percent numeric,
  warranty_retention_period text,
  warranty_period text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'engineer',
  is_approved boolean NOT NULL DEFAULT false,
  email text,
  full_name text,
  counterparty_id uuid,
  object_ids uuid[] DEFAULT '{}'
);

CREATE TABLE role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL,
  section text NOT NULL,
  can_view boolean NOT NULL DEFAULT true,
  can_edit boolean NOT NULL DEFAULT false,
  UNIQUE (role, section)
);

CREATE TABLE contract_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  field_name text,
  old_value jsonb,
  new_value jsonb,
  description text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by_role text,
  changed_by_name text
);

CREATE TABLE s3_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  s3_key text NOT NULL UNIQUE,
  file_name text NOT NULL,
  doc_category text NOT NULL DEFAULT 'general',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Как в проекте после 20260614/20260617 (без суперадмина по email).
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.is_approved = true);
$$;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- В Supabase у authenticated есть права на таблицы public (ограничивает RLS).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
