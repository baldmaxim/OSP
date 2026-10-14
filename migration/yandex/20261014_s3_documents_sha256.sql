-- Отпечаток содержимого файла у документов: без колонки свой API не подтверждает загрузку документа
-- (server/osp-api/src/routes/s3Presign.js пишет sha256). Тело supabase/migrations/20261011_s3_documents_sha256.sql.
-- 14.10.2026 колонка внесена в базу Яндекса вручную; эта миграция начинает журнал и возвращает колонку,
-- если базу загрузят из копии, где 20261011 ещё нет. Повтор безопасен. Данные не меняются.
ALTER TABLE public.s3_documents ADD COLUMN IF NOT EXISTS sha256 text;
ALTER TABLE public.s3_documents DROP CONSTRAINT IF EXISTS s3_documents_sha256_hex;
ALTER TABLE public.s3_documents
  ADD CONSTRAINT s3_documents_sha256_hex CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$');
COMMENT ON COLUMN public.s3_documents.sha256 IS
  'SHA-256 содержимого (hex, нижний регистр) — у файлов, загруженных через osp-api; NULL — загружены функцией Supabase или без отпечатка.';
