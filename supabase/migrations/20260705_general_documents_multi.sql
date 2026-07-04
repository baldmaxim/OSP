-- task 416 (доработка): одна запись general_documents = «карточка документа»,
-- в которой может быть несколько ссылок И несколько файлов одновременно.
--
-- Изменения (безопасны при повторном запуске):
--   1) general_documents: + description, гарантируем updated_at, разрешаем source_type='mixed'.
--   2) новая таблица general_document_links (несколько ссылок на документ).
--   3) перенос старых general_documents.link_url → general_document_links.
-- Старые поля (source_type, link_url, s3_document_id) НЕ удаляем — обратная совместимость:
--   файлы и так лежат в s3_documents по (owner_type='general_document', owner_id=id),
--   старый одиночный файл туда уже попал; старые ссылки переносим ниже.

-- 1) Поля general_documents
ALTER TABLE general_documents ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE general_documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Разрешаем source_type='mixed' (старые 'file'/'link' остаются валидными).
ALTER TABLE general_documents DROP CONSTRAINT IF EXISTS general_documents_source_type_check;
ALTER TABLE general_documents ADD CONSTRAINT general_documents_source_type_check
  CHECK (source_type IN ('file', 'link', 'mixed'));

-- 2) Ссылки документа
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

DROP POLICY IF EXISTS "Allow all for authenticated users" ON general_document_links;
CREATE POLICY "Allow all for authenticated users" ON general_document_links
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- 3) Перенос существующих одиночных ссылок в новую таблицу (идемпотентно)
INSERT INTO general_document_links (general_document_id, url, title, sort_order)
SELECT gd.id, gd.link_url, COALESCE(NULLIF(gd.title, ''), 'Ссылка'), 0
FROM general_documents gd
WHERE gd.link_url IS NOT NULL AND gd.link_url <> ''
  AND NOT EXISTS (
    SELECT 1 FROM general_document_links l
    WHERE l.general_document_id = gd.id AND l.url = gd.link_url
  );
