-- Ссылки, привязанные к карточке документа тендера (миграция 20260718_tender_documents_registry.sql).
-- Одна карточка tender_docs может иметь несколько ссылок и несколько файлов.
CREATE TABLE IF NOT EXISTS tender_doc_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_doc_id UUID NOT NULL REFERENCES tender_docs(id) ON DELETE CASCADE,
  title TEXT,
  url TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tender_doc_links_doc ON tender_doc_links(tender_doc_id);

ALTER TABLE tender_doc_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON tender_doc_links
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
