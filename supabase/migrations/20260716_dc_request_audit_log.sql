-- История изменений заявок на ДС. Зеркало contract_audit_log (миграция 20260515):
-- те же поля, тот же словарь event_type, тот же принцип «кто» — денормализованный
-- снимок имени на момент записи (без FK на пользователя).
--
-- event_type: created | status_changed | field_updated | soft_deleted | restored
CREATE TABLE IF NOT EXISTS dc_request_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dc_request_id UUID NOT NULL REFERENCES dc_requests(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  field_name TEXT,
  old_value JSONB,
  new_value JSONB,
  description TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by_role TEXT,
  changed_by_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_dc_request_audit_log_request_id ON dc_request_audit_log(dc_request_id);
CREATE INDEX IF NOT EXISTS idx_dc_request_audit_log_changed_at ON dc_request_audit_log(changed_at DESC);

ALTER TABLE dc_request_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for authenticated users" ON dc_request_audit_log;
CREATE POLICY "Allow all for authenticated users" ON dc_request_audit_log
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE dc_request_audit_log IS 'История изменений заявок на ДС: что изменилось (было→стало), кто и когда';
COMMENT ON COLUMN dc_request_audit_log.changed_by_name IS 'Снимок ФИО автора на момент изменения (переименование сотрудника историю не меняет)';
