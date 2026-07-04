-- task 416: общие документы компании и полезные ссылки (раздел «Общая информация» → «Документы»).
-- Метаданные; файлы — в s3_documents (owner_type='general_document', owner_id=general_documents.id).
CREATE TABLE IF NOT EXISTS general_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('file', 'link')),  -- 'file' | 'link'
  link_url TEXT,                          -- для source_type='link'
  s3_document_id UUID REFERENCES s3_documents(id) ON DELETE SET NULL,  -- для source_type='file'
  sort_order INTEGER,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_general_documents_created_at ON general_documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_general_documents_title ON general_documents(title);
CREATE INDEX IF NOT EXISTS idx_general_documents_source_type ON general_documents(source_type);
CREATE INDEX IF NOT EXISTS idx_general_documents_sort_order ON general_documents(sort_order);

ALTER TABLE general_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON general_documents
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
