-- Добавление поля ответственного сотрудника (из таблицы contacts) в тендеры
ALTER TABLE tenders
ADD COLUMN IF NOT EXISTS responsible_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tenders_responsible_contact_id ON tenders(responsible_contact_id);

COMMENT ON COLUMN tenders.responsible_contact_id IS 'Ответственный сотрудник за тендер (из таблицы contacts)';
