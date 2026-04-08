-- Создание таблицы, если ещё не существует
CREATE TABLE IF NOT EXISTS object_estimate_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  code VARCHAR(50),
  cost_name TEXT NOT NULL,
  unit VARCHAR(50),
  quantity DECIMAL(15, 4),
  unit_price DECIMAL(15, 2) DEFAULT 0,
  total_price DECIMAL(15, 2) DEFAULT 0,
  is_section BOOLEAN DEFAULT FALSE,
  original_row_number VARCHAR(20),
  unit_price_materials DECIMAL(15, 2) DEFAULT 0,
  unit_price_works DECIMAL(15, 2) DEFAULT 0,
  vat_percent DECIMAL(5, 2) DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(object_id, row_number)
);

-- Добавить колонки если таблица уже существовала без них
ALTER TABLE object_estimate_items
  ADD COLUMN IF NOT EXISTS unit_price_materials DECIMAL(15, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_price_works DECIMAL(15, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vat_percent DECIMAL(5, 2) DEFAULT 0;

-- Индексы
CREATE INDEX IF NOT EXISTS idx_object_estimate_items_object_id ON object_estimate_items(object_id);

-- Триггер для updated_at
CREATE OR REPLACE FUNCTION update_object_estimate_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_object_estimate_items_updated_at ON object_estimate_items;
CREATE TRIGGER trigger_update_object_estimate_items_updated_at
  BEFORE UPDATE ON object_estimate_items
  FOR EACH ROW
  EXECUTE FUNCTION update_object_estimate_items_updated_at();

-- RLS
ALTER TABLE object_estimate_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for authenticated users on object_estimate_items" ON object_estimate_items;
CREATE POLICY "Allow all for authenticated users on object_estimate_items" ON object_estimate_items
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Комментарии
COMMENT ON TABLE object_estimate_items IS 'Позиции сметы объекта';
COMMENT ON COLUMN object_estimate_items.unit_price_materials IS 'Цена за единицу по материалам (с НДС)';
COMMENT ON COLUMN object_estimate_items.unit_price_works IS 'Цена за единицу по работам (с НДС)';
COMMENT ON COLUMN object_estimate_items.vat_percent IS '% НДС, учтённый в ценах';
