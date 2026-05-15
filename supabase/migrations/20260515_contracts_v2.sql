-- Tasks 183-190: вторая итерация по договорам
-- - soft delete (вкладка «Удаленные»)
-- - примечание к договору
-- - аудит-лог изменений договора

-- Task 183: soft delete
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_contracts_deleted_at ON contracts(deleted_at);

-- Task 185: примечание к договору (отображается на странице деталей)
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS notes TEXT;
COMMENT ON COLUMN contracts.notes IS 'Свободное примечание по договору, ведётся на странице деталей';

-- Task 187: аудит-лог изменений договоров (создание, смена статуса, удаление, поля)
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

DROP POLICY IF EXISTS "Allow all for authenticated users" ON contract_audit_log;
CREATE POLICY "Allow all for authenticated users" ON contract_audit_log
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE contract_audit_log IS 'Аудит-лог изменений договоров (создание, смена статуса, удаление, изменения полей)';
COMMENT ON COLUMN contract_audit_log.event_type IS 'Тип события: created | status_changed | soft_deleted | restored | deleted | field_updated';
COMMENT ON COLUMN contract_audit_log.field_name IS 'Имя поля для event_type=field_updated';
COMMENT ON COLUMN contract_audit_log.old_value IS 'Прежнее значение (JSONB)';
COMMENT ON COLUMN contract_audit_log.new_value IS 'Новое значение (JSONB)';
COMMENT ON COLUMN contract_audit_log.description IS 'Человекочитаемое описание для отображения в UI';
COMMENT ON COLUMN contract_audit_log.changed_by_role IS 'Роль пользователя из localStorage(userRole)';
COMMENT ON COLUMN contract_audit_log.changed_by_name IS 'ФИО пользователя из user_roles, если доступно';
