-- task 357: к строке гарантии можно прикрепить «акт подписания» — файл, который
--   фиксирует фактическое начало гарантии. Файл живёт только в контексте строки
--   гарантии (не в общем реестре документов объекта).
--
-- Поле опциональное и независимое от start_document_id (тот — ссылка на
-- object_documents, например на тот же договор, где описано событие). При
-- удалении s3_document ссылка обнуляется (SET NULL), сама гарантия сохраняется.

ALTER TABLE object_warranties
  ADD COLUMN IF NOT EXISTS actual_start_document_id UUID
    REFERENCES s3_documents(id) ON DELETE SET NULL;

COMMENT ON COLUMN object_warranties.actual_start_document_id IS
  'Файл подписанного акта, который запустил гарантию. Лежит в s3_documents с owner_type=object. На объектную модель документов (object_documents) не выходит — виден только в табе «Гарантия».';
