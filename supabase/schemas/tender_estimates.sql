-- Таблица tender_estimate_items (Позиции сметы тендера)
-- Поддержка нескольких смет в одном тендере через estimate_name
CREATE TABLE IF NOT EXISTS tender_estimate_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tender_id UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  estimate_name TEXT DEFAULT 'Основная смета',    -- Название сметы для группировки
  row_number INTEGER NOT NULL,                    -- № п/п
  code VARCHAR(50),                               -- КОД
  cost_type VARCHAR(255),                         -- Вид затрат
  cost_name TEXT NOT NULL,                        -- Наименование затрат
  calculation_note TEXT,                          -- Примечание к расчету
  unit VARCHAR(50),                               -- Ед. изм.
  work_volume DECIMAL(15, 4),                     -- Объем по виду работ
  material_consumption DECIMAL(15, 4),            -- Общий расход по материалу
  is_section BOOLEAN DEFAULT FALSE,               -- Признак заголовка раздела
  original_row_number VARCHAR(20),                -- Оригинальный номер строки из Excel
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tender_id, row_number)
);

-- Таблица tender_counterparty_proposals (Предложения контрагентов по позициям сметы)
-- Каждый контрагент заполняет свои цены для каждой позиции
CREATE TABLE IF NOT EXISTS tender_counterparty_proposals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tender_id UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  estimate_item_id UUID NOT NULL REFERENCES tender_estimate_items(id) ON DELETE CASCADE,
  unit_price_materials DECIMAL(15, 2) DEFAULT 0, -- Цена за единицу: материалы/оборудование с НДС
  unit_price_works DECIMAL(15, 2) DEFAULT 0,     -- Цена за единицу: СМР/ПНР с НДС
  -- Рассчитываемые поля (можно вычислять на фронте или хранить):
  total_unit_price DECIMAL(15, 2) DEFAULT 0,     -- ИТОГО цена за единицу = materials + works
  total_materials DECIMAL(15, 2) DEFAULT 0,      -- Стоимость материалы = unit_price_materials * объем
  total_works DECIMAL(15, 2) DEFAULT 0,          -- Стоимость СМР/ПНР = unit_price_works * объем
  total_cost DECIMAL(15, 2) DEFAULT 0,           -- ИТОГО стоимость = total_materials + total_works
  participant_note TEXT,                          -- Примечание участника тендера
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(estimate_item_id, counterparty_id)
);

-- Таблица для хранения загруженных Excel файлов
CREATE TABLE IF NOT EXISTS tender_proposal_files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tender_id UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,
  file_url TEXT NOT NULL,
  file_size INTEGER,
  uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_tender_estimate_items_tender_id ON tender_estimate_items(tender_id);
CREATE INDEX IF NOT EXISTS idx_tender_estimate_items_row_number ON tender_estimate_items(tender_id, row_number);
CREATE INDEX IF NOT EXISTS idx_tender_estimate_items_estimate_name ON tender_estimate_items(tender_id, estimate_name);

CREATE INDEX IF NOT EXISTS idx_tender_counterparty_proposals_tender_id ON tender_counterparty_proposals(tender_id);
CREATE INDEX IF NOT EXISTS idx_tender_counterparty_proposals_counterparty_id ON tender_counterparty_proposals(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_tender_counterparty_proposals_estimate_item_id ON tender_counterparty_proposals(estimate_item_id);

CREATE INDEX IF NOT EXISTS idx_tender_proposal_files_tender_id ON tender_proposal_files(tender_id);
CREATE INDEX IF NOT EXISTS idx_tender_proposal_files_counterparty_id ON tender_proposal_files(counterparty_id);

-- Триггеры для updated_at
CREATE OR REPLACE FUNCTION update_tender_estimate_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_tender_estimate_items_updated_at
  BEFORE UPDATE ON tender_estimate_items
  FOR EACH ROW
  EXECUTE FUNCTION update_tender_estimate_items_updated_at();

CREATE OR REPLACE FUNCTION update_tender_counterparty_proposals_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_tender_counterparty_proposals_updated_at
  BEFORE UPDATE ON tender_counterparty_proposals
  FOR EACH ROW
  EXECUTE FUNCTION update_tender_counterparty_proposals_updated_at();

-- RLS политики
ALTER TABLE tender_estimate_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender_counterparty_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender_proposal_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable all for tender_estimate_items" ON tender_estimate_items FOR ALL USING (true);
CREATE POLICY "Enable all for tender_counterparty_proposals" ON tender_counterparty_proposals FOR ALL USING (true);
CREATE POLICY "Enable all for tender_proposal_files" ON tender_proposal_files FOR ALL USING (true);

-- Комментарии
COMMENT ON TABLE tender_estimate_items IS 'Позиции единой сметы тендера';
COMMENT ON TABLE tender_counterparty_proposals IS 'Ценовые предложения контрагентов по позициям сметы';
COMMENT ON TABLE tender_proposal_files IS 'Загруженные Excel файлы с КП от контрагентов';

COMMENT ON COLUMN tender_estimate_items.estimate_name IS 'Название сметы (для группировки нескольких смет в одном тендере)';
COMMENT ON COLUMN tender_estimate_items.row_number IS '№ п/п';
COMMENT ON COLUMN tender_estimate_items.code IS 'КОД позиции';
COMMENT ON COLUMN tender_estimate_items.cost_type IS 'Вид затрат';
COMMENT ON COLUMN tender_estimate_items.cost_name IS 'Наименование затрат';
COMMENT ON COLUMN tender_estimate_items.calculation_note IS 'Примечание к расчету';
COMMENT ON COLUMN tender_estimate_items.unit IS 'Единица измерения';
COMMENT ON COLUMN tender_estimate_items.work_volume IS 'Объем по виду работ';
COMMENT ON COLUMN tender_estimate_items.material_consumption IS 'Общий расход по материалу';

COMMENT ON COLUMN tender_counterparty_proposals.unit_price_materials IS 'Цена за единицу: материалы/оборудование с НДС';
COMMENT ON COLUMN tender_counterparty_proposals.unit_price_works IS 'Цена за единицу: СМР/ПНР с НДС';
COMMENT ON COLUMN tender_counterparty_proposals.total_unit_price IS 'ИТОГО цена за единицу с НДС';
COMMENT ON COLUMN tender_counterparty_proposals.total_materials IS 'Стоимость материалы/оборудование';
COMMENT ON COLUMN tender_counterparty_proposals.total_works IS 'Стоимость СМР/ПНР';
COMMENT ON COLUMN tender_counterparty_proposals.total_cost IS 'ИТОГО стоимость с НДС';
COMMENT ON COLUMN tender_counterparty_proposals.participant_note IS 'Примечание участника тендера';
