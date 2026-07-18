-- Реестр документов тендера — вкладка «Документы» внутри тендера (миграция 20260718_tender_documents_registry.sql).
-- Карточка = наименование + описание + несколько ссылок (tender_doc_links) + несколько файлов.
-- Файлы — в s3_documents с owner_type='tender', owner_id = tender_docs.id (id КАРТОЧКИ, не тендера).
-- is_final — «Итоговый документ» (решение о выборе подрядчика); не более одного на тендер.
CREATE TABLE IF NOT EXISTS tender_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  is_final BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER,
  created_by UUID,
  created_by_name TEXT,
  updated_by UUID,
  updated_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tender_docs_tender ON tender_docs(tender_id);
CREATE INDEX IF NOT EXISTS idx_tender_docs_sort ON tender_docs(tender_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tender_docs_final ON tender_docs(tender_id) WHERE is_final;

ALTER TABLE tender_docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON tender_docs
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
