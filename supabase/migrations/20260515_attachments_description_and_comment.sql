-- Task 191: краткое описание приложения объекта
ALTER TABLE object_contract_attachments ADD COLUMN IF NOT EXISTS description TEXT;
COMMENT ON COLUMN object_contract_attachments.description IS 'Краткая сводка о приложении (показывается в строке списка)';

-- Task 193: комментарий к приложению на уровне конкретного договора
-- (одно и то же стандартное приложение в разных договорах может иметь разные пометки)
ALTER TABLE contract_attachments ADD COLUMN IF NOT EXISTS comment TEXT;
COMMENT ON COLUMN contract_attachments.comment IS 'Комментарий к приложению в рамках конкретного договора';
