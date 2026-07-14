-- Договор можно завести без номера (номер присваивается позже).
-- В реестре такие договоры подсвечиваются как незаполненные.
-- UNIQUE сохраняется: в Postgres NULL не конфликтует с NULL, поэтому
-- договоров без номера может быть сколько угодно.
ALTER TABLE contracts ALTER COLUMN contract_number DROP NOT NULL;

COMMENT ON COLUMN contracts.contract_number IS 'Номер договора (необязателен — может быть присвоен позже)';
