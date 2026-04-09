-- Расширяем текстовые поля контрагентов
ALTER TABLE counterparties ALTER COLUMN name TYPE TEXT;
ALTER TABLE counterparties ALTER COLUMN work_type TYPE TEXT;
ALTER TABLE counterparties ALTER COLUMN inn TYPE TEXT;
ALTER TABLE counterparties ALTER COLUMN kpp TYPE TEXT;
ALTER TABLE counterparties ALTER COLUMN legal_address TYPE TEXT;
ALTER TABLE counterparties ALTER COLUMN actual_address TYPE TEXT;
ALTER TABLE counterparties ALTER COLUMN website TYPE TEXT;
ALTER TABLE counterparties ALTER COLUMN notes TYPE TEXT;
ALTER TABLE counterparties ALTER COLUMN department TYPE TEXT;

-- Контакты контрагентов тоже
ALTER TABLE counterparty_contacts ALTER COLUMN full_name TYPE TEXT;
ALTER TABLE counterparty_contacts ALTER COLUMN position TYPE TEXT;
ALTER TABLE counterparty_contacts ALTER COLUMN phone TYPE TEXT;
ALTER TABLE counterparty_contacts ALTER COLUMN email TYPE TEXT;
