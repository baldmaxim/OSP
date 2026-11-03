-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261202_object_documents_md.sql (Supabase): документы объекта снова без файла .md
-- (карточка объекта работает как до миграции: столбца «.md» нет).
-- ВНИМАНИЕ: теряется, какой файл к какому документу относится. Сами файлы остаются в s3_documents и в хранилище
-- (doc_category 'object_doc_md'). Перед откатом снимите связи выгрузкой:
--   select id, object_id, md_s3_document_id from public.object_documents where md_s3_document_id is not null;
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS public.idx_object_documents_md_s3;
ALTER TABLE public.object_documents DROP COLUMN IF EXISTS md_s3_document_id;

COMMIT;
