-- Карточка объекта → «Документы»: файл .md документа. Тело supabase/migrations/20261202_object_documents_md.sql:
-- колонка той же таблицы object_documents — правила по строкам и список шлюза не меняются.
--  • та же связь, что у подписанного и редактируемого файла: удалили строку файла — связь обнуляется сама;
--  • файл — s3_documents объекта, doc_category 'object_doc_md'.
-- Только добавление, повтор безопасен.
ALTER TABLE public.object_documents
  ADD COLUMN IF NOT EXISTS md_s3_document_id uuid REFERENCES public.s3_documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_object_documents_md_s3 ON public.object_documents (md_s3_document_id);

COMMENT ON COLUMN public.object_documents.md_s3_document_id IS
  'FK на s3_documents для файла .md документа. NULL = файл не загружен';
