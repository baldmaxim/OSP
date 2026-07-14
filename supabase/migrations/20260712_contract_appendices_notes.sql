-- «Приложения к Договору»: юристы ведут примечания по статусу каждого приложения.
ALTER TABLE contract_appendices ADD COLUMN IF NOT EXISTS notes TEXT;

COMMENT ON COLUMN contract_appendices.notes IS 'Примечание юриста по статусу приложения';
