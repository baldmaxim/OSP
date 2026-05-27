-- task 335: email объекта — отдельное контактное поле в карточке объекта.
-- Не зависит от email-ов сотрудников (contacts.email), это собственный
-- общий email самого объекта/проекта (например, для коммуникации с подрядчиками).

ALTER TABLE objects ADD COLUMN IF NOT EXISTS email VARCHAR(255);

COMMENT ON COLUMN objects.email IS 'Контактный email объекта (task 335)';
