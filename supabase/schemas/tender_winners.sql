-- Победители тендера (несколько — при разделении по корпусам/системам).
-- tenders.winner_counterparty_id остаётся «основным» победителем (первый
-- выбранный) для обратной совместимости: Отчёты, Сводка и автосоздание
-- договоров продолжают использовать его.
CREATE TABLE IF NOT EXISTS tender_winners (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tender_id UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  scope_note TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tender_id, counterparty_id)
);

-- Индексы для оптимизации запросов
CREATE INDEX IF NOT EXISTS idx_tender_winners_tender_id ON tender_winners(tender_id);
CREATE INDEX IF NOT EXISTS idx_tender_winners_counterparty_id ON tender_winners(counterparty_id);

-- Включение Row Level Security (RLS)
ALTER TABLE tender_winners ENABLE ROW LEVEL SECURITY;

-- Политика RLS (разрешить все операции для аутентифицированных пользователей)
CREATE POLICY "Allow all for authenticated users" ON tender_winners
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Комментарии к таблице и столбцам
COMMENT ON TABLE tender_winners IS 'Победители тендера (несколько — при разделении по корпусам/системам)';
COMMENT ON COLUMN tender_winners.tender_id IS 'Ссылка на тендер';
COMMENT ON COLUMN tender_winners.counterparty_id IS 'Ссылка на контрагента-победителя';
COMMENT ON COLUMN tender_winners.scope_note IS 'Корпус/система, по которой контрагент признан победителем';
