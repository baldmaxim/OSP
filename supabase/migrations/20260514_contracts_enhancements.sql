-- Tasks 168-175: enhancements to contracts registry
-- - work_name (task 172)
-- - responsible_contact_id (task 173)
-- - status values migration: pending->new_request, signed->in_work (task 174)
-- - per-object contract template (task 175)
-- - per-object contract attachments + contract<->attachment join (task 175)

-- Task 172: наименование работ
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS work_name TEXT;

-- Task 173: ответственный сотрудник (из таблицы contacts)
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS responsible_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contracts_responsible_contact_id ON contracts(responsible_contact_id);

-- Task 174: новые статусы
UPDATE contracts SET status = 'new_request' WHERE status = 'pending';
UPDATE contracts SET status = 'in_work' WHERE status = 'signed';
ALTER TABLE contracts ALTER COLUMN status SET DEFAULT 'new_request';

-- Task 175: per-object шаблон договора (Google Drive URL)
ALTER TABLE objects ADD COLUMN IF NOT EXISTS contract_template_link TEXT;
ALTER TABLE objects ADD COLUMN IF NOT EXISTS contract_template_name TEXT;

-- Task 175: список стандартных приложений для объекта
CREATE TABLE IF NOT EXISTS object_contract_attachments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  link TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_object_contract_attachments_object_id ON object_contract_attachments(object_id);

ALTER TABLE object_contract_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for authenticated users" ON object_contract_attachments;
CREATE POLICY "Allow all for authenticated users" ON object_contract_attachments
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Task 175: связь договор <-> выбранные приложения
CREATE TABLE IF NOT EXISTS contract_attachments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES object_contract_attachments(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (contract_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_contract_attachments_contract_id ON contract_attachments(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_attachments_attachment_id ON contract_attachments(attachment_id);

ALTER TABLE contract_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for authenticated users" ON contract_attachments;
CREATE POLICY "Allow all for authenticated users" ON contract_attachments
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
