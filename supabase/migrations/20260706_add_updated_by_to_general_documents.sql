-- task 416 (доработка): кто последним изменил документ — для колонки «Обновил».
-- Безопасно при повторном запуске; старые записи остаются с NULL (в UI показываем
-- created_by_name как fallback, иначе «—»).
ALTER TABLE general_documents
  ADD COLUMN IF NOT EXISTS updated_by UUID,
  ADD COLUMN IF NOT EXISTS updated_by_name TEXT;
