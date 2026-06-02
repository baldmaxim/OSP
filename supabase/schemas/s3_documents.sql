-- Универсальная таблица S3-документов (см. миграцию 20260528_s3_documents.sql).
-- Привязка к любой сущности через (owner_type, owner_id) — без жёсткого FK,
-- чтобы можно было добавлять новые разделы без изменений схемы.
CREATE TABLE IF NOT EXISTS s3_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type TEXT NOT NULL,             -- 'tender' | 'contract' | 'object' | 'customer' | 'general' | …
  owner_id UUID NOT NULL,
  s3_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  notes TEXT,
  -- task 370: категория документа (general | final). Используется заявками на ДС
  -- для разделения «рабочих» и «итоговых» файлов.
  doc_category TEXT NOT NULL DEFAULT 'general',
  uploaded_by UUID,
  uploaded_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_s3_documents_owner ON s3_documents(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_s3_documents_created_at ON s3_documents(created_at DESC);

ALTER TABLE s3_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON s3_documents
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
