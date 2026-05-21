-- Task 282: S3-файлы для документов объекта.
-- Старые поля signed_link/editable_link оставляем (обратная совместимость),
-- но в UI больше не используем — заменены ссылками на s3_documents.

ALTER TABLE object_documents
  ADD COLUMN IF NOT EXISTS signed_s3_document_id   UUID REFERENCES s3_documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS editable_s3_document_id UUID REFERENCES s3_documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_object_documents_signed_s3   ON object_documents(signed_s3_document_id);
CREATE INDEX IF NOT EXISTS idx_object_documents_editable_s3 ON object_documents(editable_s3_document_id);

COMMENT ON COLUMN object_documents.signed_s3_document_id   IS 'FK на s3_documents для подписанного файла. NULL = файл не загружен';
COMMENT ON COLUMN object_documents.editable_s3_document_id IS 'FK на s3_documents для редактируемого файла. NULL = файл не загружен';
COMMENT ON COLUMN object_documents.signed_link   IS 'DEPRECATED (task 282): внешняя ссылка Google Drive. Не используется в UI с 2026-05';
COMMENT ON COLUMN object_documents.editable_link IS 'DEPRECATED (task 282): внешняя ссылка Google Drive. Не используется в UI с 2026-05';
