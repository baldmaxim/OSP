-- Тип ENUM для типов документов объекта (создаем если не существует)
DO $$ BEGIN
  CREATE TYPE object_document_type AS ENUM (
    'general_contract',    -- Договор генподряда
    'additional_agreement', -- Дополнительное соглашение
    'attachment'           -- Приложение (к договору или ДС)
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Таблица документов объекта
CREATE TABLE IF NOT EXISTS object_documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  parent_document_id UUID REFERENCES object_documents(id) ON DELETE CASCADE,
  document_type object_document_type NOT NULL,
  name VARCHAR(500) NOT NULL,
  signed_link TEXT,
  editable_link TEXT,
  document_number VARCHAR(100),
  document_date DATE,
  notes TEXT,
  order_number INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Добавляем колонку parent_document_id если таблица уже существовала без неё
DO $$ BEGIN
  ALTER TABLE object_documents ADD COLUMN parent_document_id UUID REFERENCES object_documents(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

-- Добавляем колонку notes если таблица уже существовала без неё
DO $$ BEGIN
  ALTER TABLE object_documents ADD COLUMN notes TEXT;
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

-- Индексы
CREATE INDEX IF NOT EXISTS idx_object_documents_object_id ON object_documents(object_id);
CREATE INDEX IF NOT EXISTS idx_object_documents_parent ON object_documents(parent_document_id);
CREATE INDEX IF NOT EXISTS idx_object_documents_type ON object_documents(document_type);
CREATE INDEX IF NOT EXISTS idx_object_documents_order ON object_documents(object_id, order_number);

-- Триггер для автоматического обновления updated_at
CREATE OR REPLACE FUNCTION update_object_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_object_documents_updated_at ON object_documents;
CREATE TRIGGER trigger_update_object_documents_updated_at
  BEFORE UPDATE ON object_documents
  FOR EACH ROW
  EXECUTE FUNCTION update_object_documents_updated_at();

-- Enable Row Level Security
ALTER TABLE object_documents ENABLE ROW LEVEL SECURITY;

-- RLS политики
DROP POLICY IF EXISTS "Allow all for authenticated users on object_documents" ON object_documents;
CREATE POLICY "Allow all for authenticated users on object_documents" ON object_documents
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Комментарии
COMMENT ON TABLE object_documents IS 'Документы объекта (договоры, приложения, ДС)';
COMMENT ON COLUMN object_documents.document_type IS 'Тип документа: договор генподряда, приложение, доп. соглашение';
COMMENT ON COLUMN object_documents.name IS 'Наименование документа';
COMMENT ON COLUMN object_documents.signed_link IS 'Ссылка на подписанный документ (Google Drive)';
COMMENT ON COLUMN object_documents.editable_link IS 'Ссылка на редактируемый формат документа (Google Drive)';
COMMENT ON COLUMN object_documents.document_number IS 'Номер документа';
COMMENT ON COLUMN object_documents.document_date IS 'Дата документа';
COMMENT ON COLUMN object_documents.notes IS 'Примечание к документу';
COMMENT ON COLUMN object_documents.order_number IS 'Порядок сортировки внутри типа';
