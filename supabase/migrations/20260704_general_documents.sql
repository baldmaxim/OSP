-- task 416: раздел «Документы» в «Общей информации» — общие документы компании и ссылки
-- (ссылки на отпуск, инструкции, регламенты, полезные ссылки, прочие общие документы).
--
-- Метаданные документов лежат здесь; сами файлы — в s3_documents
-- (owner_type='general_document', owner_id=general_documents.id).
--   source_type='link' → заполнен link_url;
--   source_type='file' → заполнен s3_document_id (после загрузки файла).
-- № п/п в БД НЕ хранится — считается на фронте по индексу строки.

CREATE TABLE IF NOT EXISTS general_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('file', 'link')),
  link_url TEXT,
  s3_document_id UUID REFERENCES s3_documents(id) ON DELETE SET NULL,
  sort_order INTEGER,
  created_by UUID,                        -- auth.users.id
  created_by_name TEXT,                   -- снимок ФИО на момент создания
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_general_documents_created_at ON general_documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_general_documents_title ON general_documents(title);
CREATE INDEX IF NOT EXISTS idx_general_documents_source_type ON general_documents(source_type);
CREATE INDEX IF NOT EXISTS idx_general_documents_sort_order ON general_documents(sort_order);

-- RLS в стиле проекта: authenticated имеет полный доступ; реальные ограничения
-- редактирования держим на фронте через canEdit('general_documents').
ALTER TABLE general_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for authenticated users" ON general_documents;
CREATE POLICY "Allow all for authenticated users" ON general_documents
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Права ролей на новый раздел (безопасно при повторном запуске).
INSERT INTO role_permissions (role, section, can_view, can_edit) VALUES
  ('admin', 'general_documents', true, true),
  ('engineer', 'general_documents', true, true),
  ('economist', 'general_documents', true, false),
  ('lawyer', 'general_documents', true, false),
  ('construction_manager', 'general_documents', true, false)
ON CONFLICT (role, section) DO NOTHING;
