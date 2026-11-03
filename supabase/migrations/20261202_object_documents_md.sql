-- Карточка объекта → «Документы»: файл .md документа (решение пользователя 03.11.2026) — маленький столбец справа от
-- «Подписанный»: крестик и «.md» — файла нет, зелёная галочка — есть. У документа один такой файл.
--
--  • object_documents.md_s3_document_id — та же связь, что у подписанного и редактируемого файла
--    (signed_s3_document_id, editable_s3_document_id; 20260529): удалили строку файла — связь обнуляется сама.
--  • Файл — s3_documents объекта (owner_type 'object'), doc_category 'object_doc_md'.
--
-- Права не меняются: колонка той же таблицы object_documents. Только добавление, повтор безопасен.
-- База нового портала (Яндекс) — migration/yandex/20261202_object_documents_md.sql.
BEGIN;

ALTER TABLE public.object_documents
  ADD COLUMN IF NOT EXISTS md_s3_document_id uuid REFERENCES public.s3_documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_object_documents_md_s3 ON public.object_documents (md_s3_document_id);

COMMENT ON COLUMN public.object_documents.md_s3_document_id IS
  'FK на s3_documents для файла .md документа. NULL = файл не загружен';

COMMIT;
