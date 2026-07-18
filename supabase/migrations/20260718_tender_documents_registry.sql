-- Реестр документов тендера — вкладка «Документы» внутри тендера.
-- Модель зеркалит general_documents: карточка = наименование + описание + несколько
-- ссылок (tender_doc_links) + несколько файлов (s3_documents).
--
-- Файлы карточки хранятся в s3_documents с owner_type='tender', owner_id = tender_docs.id
-- (полиморфная привязка без FK). owner_id здесь — id КАРТОЧКИ документа, а не тендера,
-- поэтому файлы карточек не пересекаются с VOR/пакетными файлами тендера (owner_id = tenders.id).
-- Отдельного owner_type не заводим — правка edge-функции s3-presign и её редеплой не нужны.
--
-- is_final — «Итоговый документ» (протокол/решение о выборе подрядчика). Не более одного
-- на тендер. Показывается и во вкладке «Документы» (выделен), и в блоке победителя тендера.

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
-- Не более одного итогового документа на тендер.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tender_docs_final ON tender_docs(tender_id) WHERE is_final;

ALTER TABLE tender_docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON tender_docs
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Ссылки, привязанные к карточке документа тендера.
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
