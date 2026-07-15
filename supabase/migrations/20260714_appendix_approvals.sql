-- «Приложения к Договору»: статус согласования двумя галочками вместо текстового статуса.
-- approved_object          — согласовано с объектом
-- approved_counterparty    — согласовано с контрагентом
-- Обе галочки → строка подсвечивается зелёным (на фронте).
ALTER TABLE contract_appendices ADD COLUMN IF NOT EXISTS approved_object BOOLEAN DEFAULT false;
ALTER TABLE contract_appendices ADD COLUMN IF NOT EXISTS approved_counterparty BOOLEAN DEFAULT false;

COMMENT ON COLUMN contract_appendices.approved_object IS 'Приложение согласовано с объектом';
COMMENT ON COLUMN contract_appendices.approved_counterparty IS 'Приложение согласовано с контрагентом';
-- Старый TEXT-столбец status оставлен для истории; в UI больше не используется.
