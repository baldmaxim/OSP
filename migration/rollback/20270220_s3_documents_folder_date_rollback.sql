-- АВАРИЙНЫЙ ОТКАТ 20270220_s3_documents_folder_date: у файлов снова нет «папки с датой, куда положили явно» — каждый файл
-- показывается в папке дня своей загрузки (страница работает как до миграции: колонки нет — кнопок у папок и перетаскивания
-- в папку нет). Сами файлы и строки не удаляются. ВНИМАНИЕ: теряется выбор папки у положенных в прежние папки. Перед откатом
-- снимите его выгрузкой:
--   select id, owner_type, owner_id, file_name, created_at, folder_date from public.s3_documents where folder_date is not null;
-- Одной транзакцией, повтор безопасен. Подходит обеим базам (Supabase и Яндекса).
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.s3_documents DROP CONSTRAINT IF EXISTS s3_documents_folder_date_sane;
ALTER TABLE public.s3_documents DROP COLUMN IF EXISTS folder_date;

COMMIT;
