-- Заход Б (Р5-ядро): отпечаток содержимого файла для идемпотентной загрузки через osp-api.
--
-- Загрузка через osp-api (флаг ospApiFilesV2) идёт по ключу операции: id строки s3_documents задаёт
-- браузер (UUIDv7) при выборе файла, ключ объекта в бакете из него детерминирован, повтор любого шага
-- возвращает ту же строку. Повтор с тем же ключом, но другим файлом сервер отклоняет (409): сравнивает
-- владельца, имя, тип, размер и SHA-256 содержимого — его и хранит эта колонка. Он же пригодится для
-- сверки при переносе файлов.
--
-- Только новая колонка, NULL у всех прежних строк (их загружала функция Supabase). Права и данные не
-- меняются, повтор безопасен. Откат: ALTER TABLE public.s3_documents DROP COLUMN sha256.
BEGIN;

ALTER TABLE public.s3_documents ADD COLUMN IF NOT EXISTS sha256 text;

ALTER TABLE public.s3_documents DROP CONSTRAINT IF EXISTS s3_documents_sha256_hex;
ALTER TABLE public.s3_documents
  ADD CONSTRAINT s3_documents_sha256_hex CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN public.s3_documents.sha256 IS
  'SHA-256 содержимого (hex, нижний регистр) — у файлов, загруженных через osp-api; NULL — загружены функцией Supabase или без отпечатка.';

COMMIT;
