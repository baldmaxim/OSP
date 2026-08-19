-- task 434: папки раздела «Общая информация» → «Документы».
-- Произвольная вложенность внутри одной подгруппы (category), навигация
-- как в Проводнике. Карточки документов ссылаются сюда через
-- general_documents.folder_id.
--
-- Актуальный DDL — supabase/migrations/20260819_general_document_folders.sql.
CREATE TABLE IF NOT EXISTS general_document_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Подгруппа-владелец: general | engineers | economists | lawyers.
  -- У вложенной папки совпадает с родительской (следит триггер ниже).
  category TEXT NOT NULL DEFAULT 'general',
  -- NULL = корень подгруппы. ON DELETE RESTRICT — непустую папку удалить нельзя.
  parent_id UUID REFERENCES general_document_folders(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  sort_order INTEGER,                     -- порядок среди соседей, шаг 10
  created_by UUID,
  created_by_name TEXT,
  updated_by UUID,
  updated_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT general_document_folders_name_not_blank
    CHECK (btrim(name) <> ''),
  CONSTRAINT general_document_folders_no_self_parent
    CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_gd_folders_category_parent
  ON general_document_folders(category, parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_gd_folders_parent
  ON general_document_folders(parent_id);

-- Имена уникальны внутри одной папки (как в Проводнике); регистр и хвостовые
-- пробелы не считаются различием. Два индекса — parent_id IS NULL не участвует
-- в обычном UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gd_folders_name_in_parent
  ON general_document_folders(parent_id, lower(btrim(name)))
  WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gd_folders_name_in_root
  ON general_document_folders(category, lower(btrim(name)))
  WHERE parent_id IS NULL;

ALTER TABLE general_document_folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON general_document_folders
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Защита от циклов (папка внутрь собственного потомка «отрезала» бы поддерево
-- от корня) и наследование подгруппы от родителя.
CREATE OR REPLACE FUNCTION public.general_document_folders_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  ancestor UUID;
  parent_cat TEXT;
  depth INT := 0;
BEGIN
  NEW.updated_at := NOW();
  NEW.name := btrim(NEW.name);

  IF NEW.parent_id IS NOT NULL THEN
    SELECT category INTO parent_cat
      FROM general_document_folders WHERE id = NEW.parent_id;
    IF parent_cat IS NULL THEN
      RAISE EXCEPTION 'Родительская папка % не найдена', NEW.parent_id;
    END IF;
    NEW.category := parent_cat;

    ancestor := NEW.parent_id;
    WHILE ancestor IS NOT NULL LOOP
      IF ancestor = NEW.id THEN
        RAISE EXCEPTION 'Нельзя переместить папку внутрь самой себя';
      END IF;
      depth := depth + 1;
      IF depth > 20 THEN
        RAISE EXCEPTION 'Слишком глубокая вложенность папок (максимум 20 уровней)';
      END IF;
      SELECT parent_id INTO ancestor
        FROM general_document_folders WHERE id = ancestor;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_general_document_folders_validate ON general_document_folders;
CREATE TRIGGER trg_general_document_folders_validate
  BEFORE INSERT OR UPDATE ON general_document_folders
  FOR EACH ROW EXECUTE FUNCTION public.general_document_folders_validate();
