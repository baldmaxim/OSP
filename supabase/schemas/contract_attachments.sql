-- Связка договор <-> выбранные приложения (подмножество object_contract_attachments объекта).
CREATE TABLE IF NOT EXISTS contract_attachments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES object_contract_attachments(id) ON DELETE CASCADE,
  comment TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (contract_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_contract_attachments_contract_id ON contract_attachments(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_attachments_attachment_id ON contract_attachments(attachment_id);

ALTER TABLE contract_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON contract_attachments
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
