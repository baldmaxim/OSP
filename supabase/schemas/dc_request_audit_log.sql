-- История изменений заявок на ДС (зеркало contract_audit_log).
-- Источник истины — supabase/migrations/20260716_dc_request_audit_log.sql.
--
-- Пишется на каждое изменение заявки: created | status_changed | field_updated |
-- soft_deleted | restored. Для field_updated/status_changed хранится пара
-- old_value/new_value (было→стало) + человекочитаемый description.
--
-- «Кто» — денормализованный снимок (changed_by_name/changed_by_role), без FK на
-- пользователя: переименование сотрудника не переписывает историю задним числом.
-- ON DELETE CASCADE: безвозвратное удаление заявки уносит и её историю.
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

CREATE POLICY "Allow all for authenticated users" ON dc_request_audit_log
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
