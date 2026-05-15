-- Список стандартных приложений к договорам, заданный на уровне объекта.
-- Для каждого нового договора, привязанного к объекту, по умолчанию подтягиваются все приложения объекта;
-- набор можно изменить через таблицу contract_attachments.
CREATE TABLE IF NOT EXISTS object_contract_attachments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  link TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_object_contract_attachments_object_id ON object_contract_attachments(object_id);

ALTER TABLE object_contract_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON object_contract_attachments
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
