-- Task 215: несколько победителей тендера (разделение по корпусам/системам).
-- Junction-таблица tender_winners. tenders.winner_counterparty_id остаётся
-- «основным» победителем (первый выбранный) для обратной совместимости —
-- Отчёты, Сводка и автосоздание договоров используют его как раньше.

CREATE TABLE IF NOT EXISTS tender_winners (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tender_id UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
    scope_note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (tender_id, counterparty_id)
);

CREATE INDEX IF NOT EXISTS idx_tender_winners_tender_id ON tender_winners(tender_id);
CREATE INDEX IF NOT EXISTS idx_tender_winners_counterparty_id ON tender_winners(counterparty_id);

COMMENT ON TABLE tender_winners IS 'Победители тендера (несколько — при разделении по корпусам/системам)';
COMMENT ON COLUMN tender_winners.scope_note IS 'Корпус/система, по которой контрагент признан победителем';

ALTER TABLE tender_winners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for authenticated users" ON tender_winners;
CREATE POLICY "Allow all for authenticated users" ON tender_winners
    FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

-- Бэкфилл: переносим существующего единственного победителя в junction-таблицу
INSERT INTO tender_winners (tender_id, counterparty_id)
SELECT id, winner_counterparty_id
FROM tenders
WHERE winner_counterparty_id IS NOT NULL
ON CONFLICT (tender_id, counterparty_id) DO NOTHING;
