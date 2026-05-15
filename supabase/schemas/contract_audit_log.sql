-- Аудит-лог изменений договоров
-- Хранит универсальные события: создание, смена статуса, soft/hard удаление, изменение полей
CREATE TABLE IF NOT EXISTS contract_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  field_name TEXT,
  old_value JSONB,
  new_value JSONB,
  description TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by_role TEXT,
  changed_by_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_contract_audit_log_contract_id ON contract_audit_log(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_audit_log_changed_at ON contract_audit_log(changed_at DESC);

ALTER TABLE contract_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON contract_audit_log
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
