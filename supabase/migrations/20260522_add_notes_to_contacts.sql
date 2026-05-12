-- Поле для примечаний к контакту сотрудника (свободный текст).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT;
COMMENT ON COLUMN contacts.notes IS 'Произвольное примечание к сотруднику';
