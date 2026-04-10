-- ENUM для статуса участия контрагента в тендере
CREATE TYPE tender_counterparty_status AS ENUM ('request_sent', 'declined', 'proposal_provided', 'accepted_for_work');

-- Таблица связи между тендерами и контрагентами (многие-ко-многим)
CREATE TABLE IF NOT EXISTS tender_counterparties (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tender_id UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  status tender_counterparty_status DEFAULT 'request_sent',
  invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  notes TEXT,
  UNIQUE(tender_id, counterparty_id)
);

-- Индексы для оптимизации запросов
CREATE INDEX IF NOT EXISTS idx_tender_counterparties_tender_id ON tender_counterparties(tender_id);
CREATE INDEX IF NOT EXISTS idx_tender_counterparties_counterparty_id ON tender_counterparties(counterparty_id);

-- Включение Row Level Security (RLS)
ALTER TABLE tender_counterparties ENABLE ROW LEVEL SECURITY;

-- Политики RLS (базовые - разрешить все операции для аутентифицированных пользователей)
CREATE POLICY "Enable read access for all users" ON tender_counterparties
  FOR SELECT USING (true);

CREATE POLICY "Enable insert for authenticated users" ON tender_counterparties
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Enable update for authenticated users" ON tender_counterparties
  FOR UPDATE USING (true);

CREATE POLICY "Enable delete for authenticated users" ON tender_counterparties
  FOR DELETE USING (true);

-- Комментарии к таблице и столбцам
COMMENT ON TABLE tender_counterparties IS 'Связь между тендерами и приглашенными контрагентами';
COMMENT ON COLUMN tender_counterparties.id IS 'Уникальный идентификатор связи';
COMMENT ON COLUMN tender_counterparties.tender_id IS 'Ссылка на тендер';
COMMENT ON COLUMN tender_counterparties.counterparty_id IS 'Ссылка на контрагента';
COMMENT ON COLUMN tender_counterparties.status IS 'Статус участия контрагента в тендере (Запрос отправлен, Отказ, КП предоставлено, Принято в работу)';
COMMENT ON COLUMN tender_counterparties.invited_at IS 'Дата и время приглашения контрагента';
COMMENT ON COLUMN tender_counterparties.notes IS 'Примечания к участию контрагента в тендере';
