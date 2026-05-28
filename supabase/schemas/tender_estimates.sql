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
  outline_level INTEGER NOT NULL DEFAULT 0,       -- Уровень группировки из Excel (ws.!rows[i].level)
  original_row_number TEXT,                       -- Оригинальный номер строки из Excel (для разделов — иерархический заголовок)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- task 348: уникальность row_number в рамках одного документа (estimate_name),
  -- а не всего тендера — иначе нельзя сохранить несколько ВОРов (Электрика, ОВ…).
  UNIQUE(tender_id, estimate_name, row_number)
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

-- Файлы КП и доп. документов от контрагентов по тендеру (task 290).
-- Привязка к s3_documents через s3_document_id; метки file_kind / proposal_group_id /
-- version_label позволяют выделять КП, группировать варианты и нумеровать версии.
CREATE TABLE IF NOT EXISTS tender_proposal_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  s3_document_id UUID NOT NULL REFERENCES s3_documents(id) ON DELETE CASCADE,
  file_kind TEXT NOT NULL CHECK (file_kind IN ('commercial_proposal', 'attachment')),
  proposal_group_id UUID,
  version_label TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_tender_estimate_items_tender_id ON tender_estimate_items(tender_id);
CREATE INDEX IF NOT EXISTS idx_tender_estimate_items_row_number ON tender_estimate_items(tender_id, row_number);
CREATE INDEX IF NOT EXISTS idx_tender_estimate_items_estimate_name ON tender_estimate_items(tender_id, estimate_name);

CREATE INDEX IF NOT EXISTS idx_tender_counterparty_proposals_tender_id ON tender_counterparty_proposals(tender_id);
CREATE INDEX IF NOT EXISTS idx_tender_counterparty_proposals_counterparty_id ON tender_counterparty_proposals(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_tender_counterparty_proposals_estimate_item_id ON tender_counterparty_proposals(estimate_item_id);

CREATE INDEX IF NOT EXISTS idx_tpf_tender_counterparty ON tender_proposal_files(tender_id, counterparty_id);
CREATE INDEX IF NOT EXISTS idx_tpf_s3_document ON tender_proposal_files(s3_document_id);
CREATE INDEX IF NOT EXISTS idx_tpf_proposal_group ON tender_proposal_files(proposal_group_id) WHERE proposal_group_id IS NOT NULL;

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
COMMENT ON TABLE tender_proposal_files IS 'Файлы КП/документов от контрагентов по тендеру (связь с s3_documents)';
COMMENT ON COLUMN tender_proposal_files.file_kind IS 'commercial_proposal — это КП; attachment — вспомогательный документ';
COMMENT ON COLUMN tender_proposal_files.proposal_group_id IS 'Идентификатор группы версий одного КП (исходный → со скидкой → ...). NULL для attachment.';
COMMENT ON COLUMN tender_proposal_files.version_label IS 'Свободная метка версии: исходный, со скидкой 5%, финальный и т.п.';

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
