-- Регистрация подрядчика на сайте без одобрения администратора (решения пользователя 03.11.2026). Только база Яндекса:
-- прежний портал (Supabase) учётки не заводит. Служба — server/osp-api/src/lib/auth/signup.js.
--
-- Что меняется в модели:
--  • user_roles.self_registered — учётка заведена самой регистрацией. Такая учётка всегда подрядчик (ограничение):
--    ни правка строки, ни ошибка в интерфейсе не сделает её сотрудником;
--  • counterparties.registered_via = 'self' — компанию создала регистрация, отдел её ещё не видел;
--  • osp_auth.registrations — заявка до появления учётки: пока почта не подтверждена, ни учётки, ни контрагента нет,
--    поэтому поток ботов не засоряет реестр. Пароль задаёт хозяин почты при подтверждении (не в заявке): отпечаток, зашифрованный
--    ключом сервера, как в credentials, лежит здесь, только пока заявка ждёт решения;
--  • osp_auth.password_resets, osp_auth.mail_outbox — восстановление пароля и очередь писем. В базе — только sha256
--    одноразовых ссылок; письмо (в нём ссылка) до отправки лежит зашифрованным.
-- Контрагент в чёрном списке теряет доступ сразу: триггер блокирует учётки организации, сессии отзывает прежний триггер.
-- Данные не меняются. Повтор безопасен. Откат не нужен: новые колонки и таблицы ничего не задевают, пока регистрация
-- не включена (OSP_CONTRACTOR_SIGNUP=1).

-- ── 1. Признаки ──────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS self_registered boolean NOT NULL DEFAULT false;
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_self_registered_contractor;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_self_registered_contractor
  CHECK (NOT self_registered OR role = 'contractor');
COMMENT ON COLUMN public.user_roles.self_registered IS
  'Учётка заведена регистрацией на сайте: только подрядчик, узкий доступ (список шлюза allow-self-contractor.json и правила базы)';

ALTER TABLE public.counterparties ADD COLUMN IF NOT EXISTS registered_via text;
ALTER TABLE public.counterparties ADD COLUMN IF NOT EXISTS registered_at timestamptz;
ALTER TABLE public.counterparties DROP CONSTRAINT IF EXISTS counterparties_registered_via_check;
ALTER TABLE public.counterparties ADD CONSTRAINT counterparties_registered_via_check
  CHECK (registered_via IS NULL OR registered_via = 'self');
COMMENT ON COLUMN public.counterparties.registered_via IS
  '''self'' — компанию создала регистрация на сайте; ИНН прошёл только контрольную сумму, отдел её не проверял';

-- ── 2. Заявки на регистрацию ─────────────────────────────────────────────────────────────────────────
-- id — будущий id учётки: зашифрованный отпечаток пароля привязан к нему (AAD), как в osp_auth.credentials.
-- status: pending — ждём подтверждения почты; claim — компания уже в реестре, ждём подтверждения с её почты;
-- review — решает администратор; active — учётка создана; refused — отказ; superseded — заменена новой заявкой.
CREATE TABLE IF NOT EXISTS osp_auth.registrations (
  id uuid PRIMARY KEY,
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  email_norm text NOT NULL,
  secret text CHECK (secret IS NULL OR secret ~ '^v1:[a-z0-9]{1,16}:[A-Za-z0-9+/]+={0,2}$'),
  company_name text NOT NULL CHECK (char_length(company_name) BETWEEN 2 AND 300),
  inn text NOT NULL CHECK (inn ~ '^[0-9]{10}([0-9]{2})?$'),
  kpp text CHECK (kpp IS NULL OR kpp ~ '^[0-9]{4}[0-9A-Z]{2}[0-9]{3}$'),
  contact_name text NOT NULL CHECK (char_length(contact_name) BETWEEN 2 AND 200),
  phone text NOT NULL CHECK (phone ~ '^\+[0-9]{8,15}$'),
  consent_version text NOT NULL,
  consent_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claim', 'review', 'active', 'refused', 'superseded')),
  token_hash text CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  claim_token_hash text CHECK (claim_token_hash IS NULL OR claim_token_hash ~ '^[0-9a-f]{64}$'),
  claim_expires_at timestamptz,
  claim_sent_to integer NOT NULL DEFAULT 0,
  last_notice_at timestamptz,
  counterparty_id uuid,
  reasons text[] NOT NULL DEFAULT '{}',
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  decided_at timestamptz,
  decided_by uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS registrations_token_key ON osp_auth.registrations (token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS registrations_claim_token_key ON osp_auth.registrations (claim_token_hash) WHERE claim_token_hash IS NOT NULL;
-- Одна незавершённая заявка на почту.
CREATE UNIQUE INDEX IF NOT EXISTS registrations_open_email_key ON osp_auth.registrations (email_norm)
  WHERE status IN ('pending', 'claim', 'review');
CREATE INDEX IF NOT EXISTS registrations_created_idx ON osp_auth.registrations (created_at);
CREATE INDEX IF NOT EXISTS registrations_email_idx ON osp_auth.registrations (email_norm, created_at);
CREATE INDEX IF NOT EXISTS registrations_inn_idx ON osp_auth.registrations (inn, created_at);
CREATE INDEX IF NOT EXISTS registrations_ip_idx ON osp_auth.registrations (ip, created_at);
CREATE INDEX IF NOT EXISTS registrations_status_idx ON osp_auth.registrations (status, created_at);
CREATE INDEX IF NOT EXISTS registrations_counterparty_idx ON osp_auth.registrations (counterparty_id, created_at);

-- ── 3. Восстановление пароля: только учётки, заведённые регистрацией ─────────────────────────────────
CREATE TABLE IF NOT EXISTS osp_auth.password_resets (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON osp_auth.password_resets (user_id, created_at);

-- ── 4. Очередь писем: отправка не задерживает ответ, поэтому по времени ответа не понять, есть ли учётка ──
CREATE TABLE IF NOT EXISTS osp_auth.mail_outbox (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload text NOT NULL CHECK (payload ~ '^v1:[a-z0-9]{1,16}:[A-Za-z0-9+/]+={0,2}$'),
  attempts integer NOT NULL DEFAULT 0,
  not_before timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_outbox_due_idx ON osp_auth.mail_outbox (not_before, id);

DO $osp_signup_rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['registrations', 'password_resets', 'mail_outbox'] LOOP
    EXECUTE format('ALTER TABLE osp_auth.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE osp_auth.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS osp_auth_only ON osp_auth.%I', t);
    EXECUTE format($p$CREATE POLICY osp_auth_only ON osp_auth.%I FOR ALL TO PUBLIC
      USING (current_setting('application_name', true) = 'osp:auth')
      WITH CHECK (current_setting('application_name', true) = 'osp:auth')$p$, t);
  END LOOP;
END
$osp_signup_rls$;

-- ── 5. Чёрный список закрывает доступ сразу ──────────────────────────────────────────────────────────
-- Контрагент попал в ЧС — заблокированы все учётки подрядчика этой организации, и у дублей с тем же ИНН. Контрагента удалили —
-- учётки, заведённые регистрацией (учётки от администратора решает администратор: при слиянии дублей их переносят). Снятие
-- статуса блокировку не снимает: разблокирует администратор.
CREATE OR REPLACE FUNCTION osp_private.counterparty_closes_accounts() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog
  SET application_name = 'osp:internal'
AS $$
BEGIN
  UPDATE public.user_roles u
     SET is_blocked = true, is_approved = false, blocked_at = now(),
         blocked_by_name = CASE WHEN NEW.status::text = 'blacklist' THEN 'Контрагент в чёрном списке' ELSE 'Контрагент удалён' END
   WHERE NOT u.is_blocked
     AND (u.counterparty_id = NEW.id
          OR (NEW.status::text = 'blacklist' AND pg_catalog.regexp_replace(coalesce(NEW.inn, ''), '[^0-9]', '', 'g') <> ''
              AND u.counterparty_id IN (SELECT c.id FROM public.counterparties c
                WHERE pg_catalog.regexp_replace(coalesce(c.inn, ''), '[^0-9]', '', 'g') = pg_catalog.regexp_replace(NEW.inn, '[^0-9]', '', 'g'))))
     AND (NEW.status::text = 'blacklist' OR u.self_registered);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION osp_private.counterparty_closes_accounts() FROM PUBLIC;

DROP TRIGGER IF EXISTS counterparties_close_accounts ON public.counterparties;
CREATE TRIGGER counterparties_close_accounts AFTER UPDATE OF status, deleted_at ON public.counterparties
  FOR EACH ROW WHEN ((NEW.status::text = 'blacklist' AND OLD.status IS DISTINCT FROM NEW.status)
                     OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL))
  EXECUTE FUNCTION osp_private.counterparty_closes_accounts();
