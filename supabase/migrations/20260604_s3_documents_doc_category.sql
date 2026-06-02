-- task 370: категория документа для разделения «рабочих» и «итоговых» файлов.
-- Используется заявками на ДС (owner_type='dc_request'): general | final.
-- Default 'general' — все существующие документы остаются «рабочими».

ALTER TABLE s3_documents
  ADD COLUMN IF NOT EXISTS doc_category TEXT NOT NULL DEFAULT 'general';
