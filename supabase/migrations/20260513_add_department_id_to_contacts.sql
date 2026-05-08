-- Привязка контакта к отделу. Используется в столбце «Отдел» на странице
-- «Контактные данные → Сотрудники» и в админке.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_department_id ON contacts(department_id);

COMMENT ON COLUMN contacts.department_id IS 'Отдел сотрудника (FK на departments)';
