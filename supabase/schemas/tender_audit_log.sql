-- Аудит-лог изменений тендеров (справочная схема)
CREATE TABLE IF NOT EXISTS tender_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,            -- 'created' | 'status_changed' | 'winner_assigned' | 'field_updated'
  field_name TEXT,                     -- имя поля для event_type='field_updated'
  old_value JSONB,
  new_value JSONB,
  description TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by_role TEXT,
  changed_by_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_tender_audit_log_tender_id ON tender_audit_log(tender_id);
CREATE INDEX IF NOT EXISTS idx_tender_audit_log_changed_at ON tender_audit_log(changed_at DESC);

ALTER TABLE tender_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON tender_audit_log
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
