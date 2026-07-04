-- task 416 (доработка): ссылки, привязанные к карточке общего документа.
-- Одна карточка general_documents может иметь несколько ссылок и несколько файлов.
CREATE TABLE IF NOT EXISTS general_document_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  general_document_id UUID NOT NULL REFERENCES general_documents(id) ON DELETE CASCADE,
  title TEXT,
  url TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_general_document_links_doc ON general_document_links(general_document_id);

ALTER TABLE general_document_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON general_document_links
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
