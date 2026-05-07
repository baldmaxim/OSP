-- Переименование статусов тендеров и удаление статуса 'Принято в работу'
-- Поле tenders.status — VARCHAR(50), не enum, поэтому достаточно UPDATE для существующих записей
-- + поменять DEFAULT на новое название.

UPDATE tenders SET status = 'Заявка на тендер' WHERE status = 'Не начат';
UPDATE tenders SET status = 'Подготовка ВОР' WHERE status = 'Ожидание ВОР';
-- 'Принято в работу' переводим в 'Завершен' (статус удаляется из выбора)
UPDATE tenders SET status = 'Завершен' WHERE status = 'Принято в работу';

ALTER TABLE tenders ALTER COLUMN status SET DEFAULT 'Заявка на тендер';
