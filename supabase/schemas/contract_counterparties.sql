-- Стороны договора (несколько — для трёхсторонних договоров).
-- contracts.counterparty_id остаётся «основным» контрагентом (sort_order = 0)
-- для обратной совместимости: Отчёты и сводные выборки продолжают использовать его.
CREATE TABLE IF NOT EXISTS contract_counterparties (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(contract_id, counterparty_id)
);

CREATE INDEX IF NOT EXISTS idx_contract_counterparties_contract_id
  ON contract_counterparties(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_counterparties_counterparty_id
  ON contract_counterparties(counterparty_id);

ALTER TABLE contract_counterparties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON contract_counterparties
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
