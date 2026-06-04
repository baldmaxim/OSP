-- ПСДЦ договора (Проект сметы договорной цены / ВОР) — одна на договор.
-- Строки импортируются из Excel. Контролируют объёмы и суммы по договору.
-- Колонки agreement_id/change_type/target_item_id зарезервированы под ДС (дельта-модель, фаза 2):
-- базовые строки имеют agreement_id IS NULL; строки ДС ссылаются на ДС и на изменяемую строку.
CREATE TABLE IF NOT EXISTS contract_psdc_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  agreement_id UUID,                              -- резерв под ДС (NULL = базовая ПСДЦ)
  change_type VARCHAR(10),                         -- 'add' | 'modify' | 'remove' (NULL = базовая)
  target_item_id UUID,                             -- ссылка на изменяемую/удаляемую строку
  row_number INTEGER,
  code VARCHAR(50),
  cost_name TEXT,
  unit VARCHAR(50),
  quantity DECIMAL(15, 4),
  unit_price_materials DECIMAL(15, 2) DEFAULT 0,
  unit_price_works DECIMAL(15, 2) DEFAULT 0,
  unit_price DECIMAL(15, 2) DEFAULT 0,
  total_price DECIMAL(15, 2) DEFAULT 0,
  vat_percent DECIMAL(5, 2) DEFAULT 0,
  is_davalchesky BOOLEAN DEFAULT false,            -- давальческий: объём учитываем, сумму НЕТ
  is_section BOOLEAN DEFAULT false,
  original_row_number VARCHAR(20),
  notes TEXT,
  import_mode VARCHAR(20) DEFAULT 'separate',      -- 'separate' | 'combined'
  is_approved BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Уникальность базовых строк (строки ДС не ограничиваем).
CREATE UNIQUE INDEX IF NOT EXISTS uq_psdc_base_row
  ON contract_psdc_items(contract_id, row_number)
  WHERE agreement_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_psdc_contract_id ON contract_psdc_items(contract_id);

CREATE OR REPLACE FUNCTION update_contract_psdc_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_contract_psdc_items_updated_at
  BEFORE UPDATE ON contract_psdc_items
  FOR EACH ROW
  EXECUTE FUNCTION update_contract_psdc_items_updated_at();

ALTER TABLE contract_psdc_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated users on contract_psdc_items" ON contract_psdc_items
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE contract_psdc_items IS 'ПСДЦ договора — строки сметы договорной цены (контроль объёмов и сумм)';
COMMENT ON COLUMN contract_psdc_items.is_davalchesky IS 'Давальческий материал: объём отображается, в сумму договора не входит';
