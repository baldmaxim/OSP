-- task 416: общие документы компании и полезные ссылки (раздел «Общая информация» → «Документы»).
-- Метаданные; файлы — в s3_documents (owner_type='general_document', owner_id=general_documents.id).
CREATE TABLE IF NOT EXISTS general_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,                        -- необязательное примечание к карточке документа
  -- 'mixed' — карточка с несколькими ссылками и/или файлами (текущая модель).
  -- 'file'/'link' — старые одиночные записи (обратная совместимость).
  source_type TEXT NOT NULL CHECK (source_type IN ('file', 'link', 'mixed')),
  -- Подгруппа: general (Общая информация) | engineers | economists | lawyers.
  category TEXT NOT NULL DEFAULT 'general',
  link_url TEXT,                          -- DEPRECATED (старые одиночные ссылки → general_document_links)
  s3_document_id UUID REFERENCES s3_documents(id) ON DELETE SET NULL,  -- DEPRECATED (файлы — по owner_type/owner_id)
  sort_order INTEGER,
  created_by UUID,
  created_by_name TEXT,
  updated_by UUID,                        -- кто последним изменил (для колонки «Обновил»)
  updated_by_name TEXT,                   -- снимок ФИО/email последнего изменившего
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
