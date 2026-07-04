-- Договоры: разрешаем заводить договор без обязательного указания даты договора.
-- Раньше contract_date был DATE NOT NULL — снимаем NOT NULL, чтобы поле было опциональным.
-- Существующие данные не затрагиваются.
ALTER TABLE contracts ALTER COLUMN contract_date DROP NOT NULL;
