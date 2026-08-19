-- task 434: папки в разделе «Общая информация → Документы».
--
-- Внутри каждой подгруппы (category: general/engineers/economists/lawyers)
-- можно создавать папки произвольной вложенности и складывать в них карточки
-- документов — навигация как в Проводнике Windows.
--
-- Модель: ОТДЕЛЬНАЯ таблица папок + general_documents.folder_id.
-- Не флаг is_folder в general_documents: у папки нет ни source_type (NOT NULL
-- CHECK), ни ссылок (general_document_links), ни файлов (s3_documents) —
-- смешение сущностей сломало бы все существующие выборки и валидацию карточки.
--
-- Миграция идемпотентна (можно применять повторно) и обратно совместима:
-- folder_id по умолчанию NULL, поэтому старый фронтенд продолжит показывать
-- плоский список.

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Папки.
CREATE TABLE IF NOT EXISTS general_document_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Подгруппа-владелец. Папка живёт внутри одной вкладки; у вложенной папки
  -- category обязан совпадать с родительским (следит триггер ниже).
  category TEXT NOT NULL DEFAULT 'general',
  -- ON DELETE RESTRICT: папку с содержимым удалить нельзя — сначала очистить.
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

COMMENT ON TABLE general_document_folders IS
  'Папки раздела «Документы»: произвольная вложенность внутри одной подгруппы';
COMMENT ON COLUMN general_document_folders.parent_id IS
  'Родительская папка; NULL = корень подгруппы. ON DELETE RESTRICT — непустую папку удалить нельзя';
COMMENT ON COLUMN general_document_folders.sort_order IS
  'Порядок среди соседей одного родителя (шаг 10 — запас под вставки без перенумерации)';

CREATE INDEX IF NOT EXISTS idx_gd_folders_category_parent
  ON general_document_folders(category, parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_gd_folders_parent
  ON general_document_folders(parent_id);

-- Имена внутри одной папки уникальны (как в Проводнике). Регистр и хвостовые
-- пробелы не считаются различием. Два индекса — потому что parent_id IS NULL
-- не участвует в обычном UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gd_folders_name_in_parent
  ON general_document_folders(parent_id, lower(btrim(name)))
  WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gd_folders_name_in_root
  ON general_document_folders(category, lower(btrim(name)))
  WHERE parent_id IS NULL;

ALTER TABLE general_document_folders ENABLE ROW LEVEL SECURITY;

-- Как и у general_documents: доступ у любого авторизованного, ограничение
-- на редактирование — на уровне приложения (право 'general_documents').
DROP POLICY IF EXISTS "Allow all for authenticated users" ON general_document_folders;
CREATE POLICY "Allow all for authenticated users" ON general_document_folders
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Защита от циклов и от смешения подгрупп.
--
-- Перенос папки внутрь собственного потомка «отрезал» бы поддерево от корня:
-- строки остались бы в БД, но ни один обход сверху их бы не нашёл. Ловим это
-- подъёмом по цепочке родителей ДО записи.
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
    -- Вложенная папка всегда в той же подгруппе, что и родитель.
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

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Привязка карточки документа к папке.
ALTER TABLE general_documents
  ADD COLUMN IF NOT EXISTS folder_id UUID
    REFERENCES general_document_folders(id) ON DELETE RESTRICT;

COMMENT ON COLUMN general_documents.folder_id IS
  'Папка, в которой лежит карточка; NULL = корень подгруппы. ON DELETE RESTRICT — папку с документами удалить нельзя';

CREATE INDEX IF NOT EXISTS idx_general_documents_folder
  ON general_documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_general_documents_category_folder
  ON general_documents(category, folder_id, sort_order);

-- ────────────────────────────────────────────────────────────────────────────
-- 4) category документа всегда наследуется от папки.
--
-- Иначе документ, перенесённый в папку другой подгруппы, мог бы остаться с
-- прежней category и пропасть из обеих вкладок: страница фильтрует по
-- category, а содержимое папки — по folder_id.
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
