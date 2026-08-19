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
  -- task 434: папка, в которой лежит карточка; NULL = корень подгруппы.
  -- ON DELETE RESTRICT — папку с документами удалить нельзя.
  folder_id UUID REFERENCES general_document_folders(id) ON DELETE RESTRICT,
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
CREATE INDEX IF NOT EXISTS idx_general_documents_category ON general_documents(category);
CREATE INDEX IF NOT EXISTS idx_general_documents_folder ON general_documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_general_documents_category_folder ON general_documents(category, folder_id, sort_order);

ALTER TABLE general_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON general_documents
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- task 434: category документа наследуется от папки. Иначе документ,
-- перенесённый в папку другой подгруппы, остался бы с прежней category и
-- пропал из обеих вкладок (страница фильтрует по category, папка — по folder_id).
CREATE OR REPLACE FUNCTION public.general_documents_sync_folder_category()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  folder_cat TEXT;
BEGIN
  IF NEW.folder_id IS NOT NULL THEN
    SELECT category INTO folder_cat
      FROM general_document_folders WHERE id = NEW.folder_id;
    IF folder_cat IS NULL THEN
      RAISE EXCEPTION 'Папка % не найдена', NEW.folder_id;
    END IF;
    NEW.category := folder_cat;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_general_documents_sync_folder_category ON general_documents;
CREATE TRIGGER trg_general_documents_sync_folder_category
  BEFORE INSERT OR UPDATE ON general_documents
  FOR EACH ROW EXECUTE FUNCTION public.general_documents_sync_folder_category();
