-- Добавление поля notes к таблице tenders (примечания по тендеру)
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS notes TEXT;
COMMENT ON COLUMN tenders.notes IS 'Примечание по тендеру (свободный текст, ведётся ответственным)';
