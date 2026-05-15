-- Таблица contracts (Реестр договоров)
CREATE TABLE IF NOT EXISTS contracts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_number VARCHAR(100) NOT NULL UNIQUE,
  contract_date DATE NOT NULL,
  counterparty_id UUID REFERENCES counterparties(id) ON DELETE SET NULL,
  object_id UUID REFERENCES objects(id) ON DELETE SET NULL,
  contract_amount DECIMAL(15, 2) NOT NULL CHECK (contract_amount >= 0),
  warranty_retention_percent DECIMAL(5, 2) CHECK (warranty_retention_percent >= 0 AND warranty_retention_percent <= 100),
  warranty_retention_period VARCHAR(100),
  work_start_date DATE,
  work_end_date DATE,
  warranty_period VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'new_request',
  document_link TEXT,
  tender_id UUID REFERENCES tenders(id),
  work_name TEXT,
  responsible_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  notes TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Индексы для оптимизации запросов
CREATE INDEX IF NOT EXISTS idx_contracts_contract_number ON contracts(contract_number);
CREATE INDEX IF NOT EXISTS idx_contracts_counterparty_id ON contracts(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_contracts_object_id ON contracts(object_id);
CREATE INDEX IF NOT EXISTS idx_contracts_contract_date ON contracts(contract_date);
CREATE INDEX IF NOT EXISTS idx_contracts_work_dates ON contracts(work_start_date, work_end_date);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_deleted_at ON contracts(deleted_at);

-- Триггер для автоматического обновления updated_at
CREATE OR REPLACE FUNCTION update_contracts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_contracts_updated_at
  BEFORE UPDATE ON contracts
  FOR EACH ROW
  EXECUTE FUNCTION update_contracts_updated_at();

-- Включение Row Level Security (RLS)
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;

-- Политики RLS (базовые - разрешить все операции для аутентифицированных пользователей)
CREATE POLICY "Enable read access for all users" ON contracts
  FOR SELECT USING (true);

CREATE POLICY "Enable insert for authenticated users" ON contracts
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Enable update for authenticated users" ON contracts
  FOR UPDATE USING (true);

CREATE POLICY "Enable delete for authenticated users" ON contracts
  FOR DELETE USING (true);

-- Комментарии к таблице и столбцам
COMMENT ON TABLE contracts IS 'Реестр договоров с подрядчиками';
COMMENT ON COLUMN contracts.id IS 'Уникальный идентификатор договора';
COMMENT ON COLUMN contracts.contract_number IS 'Номер договора';
COMMENT ON COLUMN contracts.contract_date IS 'Дата заключения договора';
COMMENT ON COLUMN contracts.counterparty_id IS 'Ссылка на контрагента (подрядчика)';
COMMENT ON COLUMN contracts.object_id IS 'Ссылка на объект строительства';
COMMENT ON COLUMN contracts.contract_amount IS 'Сумма по договору (рубли)';
COMMENT ON COLUMN contracts.warranty_retention_percent IS 'Процент гарантийных удержаний';
COMMENT ON COLUMN contracts.warranty_retention_period IS 'Срок гарантийных удержаний';
COMMENT ON COLUMN contracts.work_start_date IS 'Дата начала работ';
COMMENT ON COLUMN contracts.work_end_date IS 'Дата окончания работ';
COMMENT ON COLUMN contracts.warranty_period IS 'Срок гарантии на выполненные работы';
COMMENT ON COLUMN contracts.document_link IS 'Ссылка на документ договора (Google Drive и т.п.)';
COMMENT ON COLUMN contracts.tender_id IS 'Ссылка на тендер, по которому заключён договор';
COMMENT ON COLUMN contracts.created_at IS 'Дата и время создания записи';
COMMENT ON COLUMN contracts.updated_at IS 'Дата и время последнего обновления записи';
