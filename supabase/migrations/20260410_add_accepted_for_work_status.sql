-- Добавление нового статуса участия контрагента в тендере: "Принято в работу"
ALTER TYPE tender_counterparty_status ADD VALUE IF NOT EXISTS 'accepted_for_work';

COMMENT ON COLUMN tender_counterparties.status IS 'Статус участия контрагента в тендере (Запрос отправлен, Отказ, КП предоставлено, Принято в работу)';
