-- Подгруппы в разделе «Общая информация → Документы»: Общая информация (текущий
-- реестр, значение по умолчанию), Инженеры, Экономисты, Юристы.
-- Свободный TEXT (без CHECK) — чтобы при желании можно было добавить новые подгруппы
-- без миграции; набор значений контролирует приложение.
ALTER TABLE general_documents
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general';

COMMENT ON COLUMN general_documents.category IS
  'Подгруппа документа: general (Общая информация) | engineers | economists | lawyers';

CREATE INDEX IF NOT EXISTS idx_general_documents_category ON general_documents(category);
