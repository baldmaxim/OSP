-- Списки файлов с папками по дням (S3DocumentList с dateFolders; пока «Должная осмотрительность» карточки контрагента): файл можно
-- положить в уже существующую папку с датой, кнопкой у папки и перетаскиванием (решение пользователя 19.11.2026). Тело —
-- supabase/migrations/20270220_s3_documents_folder_date.sql.
--
-- Папка в списке — день загрузки (created_at по часам браузера); folder_date — день папки, в которую файл положили явно.
-- NULL — папка по дню загрузки, как прежде: прежние строки остаются в своих папках. Время загрузки (created_at) не подменяется:
-- от него — «Когда» и отметки ДО в реестрах. Пишут osp-api (confirm) и прежний портал при вставке строки; правила строк
-- s3_documents и список шлюза не меняются (колонка той же таблицы, чтение — «*»). Данные не меняются: колонка у всех пустая.
-- Повтор безопасен. Проверка — 20270220_s3_documents_folder_date.check.sql, для прода — migration/backup/checks/20270220.sql;
-- откат — migration/rollback/20270220_s3_documents_folder_date_rollback.sql.
ALTER TABLE public.s3_documents ADD COLUMN IF NOT EXISTS folder_date date;

ALTER TABLE public.s3_documents DROP CONSTRAINT IF EXISTS s3_documents_folder_date_sane;
ALTER TABLE public.s3_documents ADD CONSTRAINT s3_documents_folder_date_sane
  CHECK (folder_date IS NULL OR folder_date >= DATE '2000-01-01');

COMMENT ON COLUMN public.s3_documents.folder_date IS
  'Папка с датой в списке файлов, куда файл положили явно; NULL — папка по дню загрузки (created_at)';
