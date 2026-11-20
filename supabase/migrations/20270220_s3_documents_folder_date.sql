-- Списки файлов с папками по дням («Должная осмотрительность» карточки контрагента): файл можно положить в уже существующую папку
-- с датой (решение пользователя 19.11.2026). Подробно — в базе нового портала: migration/yandex/20270220_s3_documents_folder_date.sql.
-- Тело то же. Данные не меняются. Проверка: migration/backup/checks/20270220.sql, откат —
-- migration/rollback/20270220_s3_documents_folder_date_rollback.sql.
-- Применять в нерабочее время: ALTER TABLE ненадолго блокирует таблицу файлов.

BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.s3_documents ADD COLUMN IF NOT EXISTS folder_date date;

ALTER TABLE public.s3_documents DROP CONSTRAINT IF EXISTS s3_documents_folder_date_sane;
ALTER TABLE public.s3_documents ADD CONSTRAINT s3_documents_folder_date_sane
  CHECK (folder_date IS NULL OR folder_date >= DATE '2000-01-01');

COMMENT ON COLUMN public.s3_documents.folder_date IS
  'Папка с датой в списке файлов, куда файл положили явно; NULL — папка по дню загрузки (created_at)';

NOTIFY pgrst, 'reload schema';

COMMIT;
