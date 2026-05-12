-- Расширения для document_check_requests:
-- - responsible_contact_id: ответственный сотрудник за проверку
-- - document_link: ссылка на проверяемый документ (Google/Yandex Drive и т.п.)
-- - история изменений (отдельная таблица) — для модалки «История заявки» в канбане.

ALTER TABLE document_check_requests
  ADD COLUMN IF NOT EXISTS responsible_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE document_check_requests
  ADD COLUMN IF NOT EXISTS document_link TEXT;

CREATE INDEX IF NOT EXISTS idx_dcr_responsible ON document_check_requests(responsible_contact_id);

COMMENT ON COLUMN document_check_requests.responsible_contact_id IS 'Ответственный сотрудник за проверку (FK на contacts)';
COMMENT ON COLUMN document_check_requests.document_link IS 'Ссылка на проверяемый документ (Google/Yandex Drive)';

-- История изменений заявок
CREATE TABLE IF NOT EXISTS document_check_request_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES document_check_requests(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  description TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by_role TEXT,
  changed_by_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_dcrh_request_id ON document_check_request_history(request_id);
CREATE INDEX IF NOT EXISTS idx_dcrh_changed_at ON document_check_request_history(changed_at DESC);

ALTER TABLE document_check_request_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON document_check_request_history
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE document_check_request_history IS 'История изменений заявок на проверку ДП/ДС (создание, перемещения по канбану, смена ответственного и т.д.)';
COMMENT ON COLUMN document_check_request_history.event_type IS 'Тип события: created | status_changed | field_updated';
