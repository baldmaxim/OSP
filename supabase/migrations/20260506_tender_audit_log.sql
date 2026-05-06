-- Аудит-лог изменений тендеров
-- Хранит универсальные события: создание, смена статуса, выбор победителя, изменение полей

CREATE TABLE IF NOT EXISTS tender_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  field_name TEXT,
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

COMMENT ON TABLE tender_audit_log IS 'Аудит-лог изменений тендеров (создание, смена статуса, выбор победителя, изменения полей)';
COMMENT ON COLUMN tender_audit_log.event_type IS 'Тип события: created | status_changed | winner_assigned | field_updated';
COMMENT ON COLUMN tender_audit_log.field_name IS 'Имя поля для event_type=field_updated';
COMMENT ON COLUMN tender_audit_log.old_value IS 'Прежнее значение (JSONB)';
COMMENT ON COLUMN tender_audit_log.new_value IS 'Новое значение (JSONB)';
COMMENT ON COLUMN tender_audit_log.description IS 'Человекочитаемое описание для отображения в UI';
COMMENT ON COLUMN tender_audit_log.changed_by_role IS 'Роль пользователя из localStorage(userRole)';
COMMENT ON COLUMN tender_audit_log.changed_by_name IS 'ФИО пользователя из user_roles, если доступно';
