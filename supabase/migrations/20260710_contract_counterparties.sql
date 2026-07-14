-- Несколько контрагентов у договора (трёхсторонний договор и т.п.).
-- contracts.counterparty_id остаётся «основным» контрагентом (первая сторона) —
-- на него завязаны Отчёты и прочие потребители, поэтому колонка не удаляется.
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

DROP POLICY IF EXISTS "Allow all for authenticated users" ON contract_counterparties;
CREATE POLICY "Allow all for authenticated users" ON contract_counterparties
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE contract_counterparties IS 'Стороны договора (может быть несколько). sort_order = 0 — основной контрагент (дублируется в contracts.counterparty_id)';

-- Бэкфилл: существующие договоры получают одну сторону — текущего контрагента.
INSERT INTO contract_counterparties (contract_id, counterparty_id, sort_order)
SELECT id, counterparty_id, 0 FROM contracts WHERE counterparty_id IS NOT NULL
ON CONFLICT (contract_id, counterparty_id) DO NOTHING;
