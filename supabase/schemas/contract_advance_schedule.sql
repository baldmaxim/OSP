-- График авансирования договора: в определённые даты — определённые суммы.
CREATE TABLE IF NOT EXISTS contract_advance_schedule (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  planned_date DATE,
  amount DECIMAL(15, 2),
  description TEXT,
  paid_date DATE,                 -- факт выдачи (необязательно; полноценные оплаты — следующий этап)
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advance_contract_id ON contract_advance_schedule(contract_id);

CREATE OR REPLACE FUNCTION update_contract_advance_schedule_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_contract_advance_schedule_updated_at
  BEFORE UPDATE ON contract_advance_schedule
  FOR EACH ROW
  EXECUTE FUNCTION update_contract_advance_schedule_updated_at();

ALTER TABLE contract_advance_schedule ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated users on contract_advance_schedule" ON contract_advance_schedule
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE contract_advance_schedule IS 'График авансирования договора';
