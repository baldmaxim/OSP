-- Раздел «Заявки на проверку ДП/ДС».
--
-- До этого проверка договоров и допсоглашений жила в почте: заявку слали письмом,
-- статус узнавали перепиской. Здесь заявка — карточка, которая идёт по канбану:
--   Новая заявка → В работе → Выгрузка по ЭДО → Загрузка в Signal →
--   Занесение в 1С → Завершено → Ожидаем скан ДП/ДС (бумага)
--
-- «Ожидаем скан» СТОИТ ПОСЛЕ «Завершено» намеренно (решение пользователя): по
-- системе документ готов, но бумажный оригинал с подписью ещё не вернулся.
--
-- Заявка НЕ привязана к записи реестра «Договоры и ДС»: проверка идёт как раз до
-- того, как договор туда заводят, поэтому объект, контрагент, тип, № и дата
-- вводятся руками.
--
-- Файлы заявки — в s3_documents (owner_type='doc_check_request'). Требуется
-- передеплой edge-функции s3-presign: в FOLDER_BY_OWNER добавлен новый тип.
--
-- Миграция идемпотентна.
-- ЗАВИСИМОСТЬ: функция public.is_negotiation_employee() из
-- 20260815_contract_negotiation_foundation.sql — на ней стоит RLS, как у задач.

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Заявки.
CREATE TABLE IF NOT EXISTS doc_check_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE SET NULL: удаление объекта или контрагента не должно уносить
  -- историю проверки документа.
  object_id UUID REFERENCES objects(id) ON DELETE SET NULL,
  counterparty_id UUID REFERENCES counterparties(id) ON DELETE SET NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('dp', 'ds')),
  doc_number TEXT,
  doc_date DATE,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'in_progress', 'edo', 'signal', 'accounting', 'done', 'awaiting_scan')),
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,   -- порядок карточки внутри колонки доски
  deleted_at TIMESTAMPTZ,                  -- soft delete (вкладка «Удалённые»), как в tasks
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_name TEXT
);

COMMENT ON TABLE doc_check_requests IS 'Заявки на проверку ДП/ДС — канбан вместо переписки по почте';
COMMENT ON COLUMN doc_check_requests.doc_type IS 'dp — договор подряда, ds — дополнительное соглашение';
COMMENT ON COLUMN doc_check_requests.status IS
  'new | in_progress | edo (выгрузка по ЭДО) | signal (загрузка в Signal) | accounting (занесение в 1С) | done | awaiting_scan (ждём подписанный бумажный оригинал)';
COMMENT ON COLUMN doc_check_requests.sort_order IS 'Порядок карточки внутри колонки канбана';

CREATE INDEX IF NOT EXISTS idx_doc_check_requests_object ON doc_check_requests(object_id);
CREATE INDEX IF NOT EXISTS idx_doc_check_requests_counterparty ON doc_check_requests(counterparty_id);
-- Основной запрос доски: живые заявки в порядке колонок.
CREATE INDEX IF NOT EXISTS idx_doc_check_requests_active
  ON doc_check_requests(status, sort_order) WHERE deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) История изменений — структура та же, что у task_audit_log.
CREATE TABLE IF NOT EXISTS doc_check_request_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES doc_check_requests(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,               -- created | status_changed | field_updated | soft_deleted | restored
  field_name TEXT,
  old_value JSONB,
  new_value JSONB,
  description TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by_role TEXT,
  changed_by_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_doc_check_audit_request ON doc_check_request_audit_log(request_id);
CREATE INDEX IF NOT EXISTS idx_doc_check_audit_changed_at ON doc_check_request_audit_log(changed_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Триггер updated_at.
CREATE OR REPLACE FUNCTION update_doc_check_requests_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_doc_check_requests_updated_at ON doc_check_requests;
CREATE TRIGGER trg_doc_check_requests_updated_at BEFORE UPDATE ON doc_check_requests
  FOR EACH ROW EXECUTE FUNCTION update_doc_check_requests_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- 4) RLS: внутренний инструмент. Подрядчики раздела не видят вовсе — то же
--    правило и та же функция, что у задач (20260818). Кто и что может менять
--    внутри раздела, решают права роли в админке, а не политики.
ALTER TABLE doc_check_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_check_request_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS doc_check_requests_employee_all ON doc_check_requests;
DROP POLICY IF EXISTS doc_check_audit_employee_all ON doc_check_request_audit_log;

CREATE POLICY doc_check_requests_employee_all ON doc_check_requests
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());
CREATE POLICY doc_check_audit_employee_all ON doc_check_request_audit_log
  FOR ALL TO authenticated
  USING (public.is_negotiation_employee()) WITH CHECK (public.is_negotiation_employee());

-- ────────────────────────────────────────────────────────────────────────────
-- 5) Права ролей. Без этих строк раздел не увидит НИКТО: canView() в
--    RoleContext по умолчанию возвращает false. Дальше видимость правится в
--    админке, здесь только разумный старт.
INSERT INTO role_permissions (role, section, can_view, can_edit) VALUES
  ('admin', 'doc_check_requests', true, true),
  ('lawyer', 'doc_check_requests', true, true),
  ('engineer', 'doc_check_requests', true, true),
  ('economist', 'doc_check_requests', true, true),
  ('construction_manager', 'doc_check_requests', true, false)
ON CONFLICT (role, section) DO NOTHING;
