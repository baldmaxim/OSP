-- Task 277: универсальная таблица для документов, хранимых в S3-совместимом
-- хранилище (cloud.ru). Привязка к сущностям через пару (owner_type, owner_id),
-- без FK — таблица обслуживает несколько разделов (тендеры, договоры, объекты,
-- инфо с заказчиком, общая информация и т. д.).
CREATE TABLE IF NOT EXISTS s3_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type TEXT NOT NULL,             -- 'tender' | 'contract' | 'object' | 'customer' | 'general'
  owner_id UUID NOT NULL,
  s3_key TEXT NOT NULL UNIQUE,          -- путь в бакете: 'tenders/{tender_id}/{uuid}-{file_name}'
  file_name TEXT NOT NULL,              -- оригинальное имя файла (для отображения и скачивания)
  mime_type TEXT,
  size_bytes BIGINT,
  notes TEXT,
  uploaded_by UUID,                     -- auth.users.id
  uploaded_by_name TEXT,                -- снимок full_name на момент загрузки
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_s3_documents_owner ON s3_documents(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_s3_documents_created_at ON s3_documents(created_at DESC);

ALTER TABLE s3_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON s3_documents
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
