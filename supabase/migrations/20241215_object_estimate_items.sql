-- Таблица позиций сметы объекта
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
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(object_id, row_number)
);

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

CREATE TRIGGER trigger_update_object_estimate_items_updated_at
  BEFORE UPDATE ON object_estimate_items
  FOR EACH ROW
  EXECUTE FUNCTION update_object_estimate_items_updated_at();

-- RLS
ALTER TABLE object_estimate_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated users on object_estimate_items" ON object_estimate_items
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Комментарии
COMMENT ON TABLE object_estimate_items IS 'Позиции сметы объекта';
COMMENT ON COLUMN object_estimate_items.row_number IS '№ п/п';
COMMENT ON COLUMN object_estimate_items.code IS 'КОД позиции';
COMMENT ON COLUMN object_estimate_items.cost_name IS 'Наименование';
COMMENT ON COLUMN object_estimate_items.unit IS 'Единица измерения';
COMMENT ON COLUMN object_estimate_items.quantity IS 'Количество';
COMMENT ON COLUMN object_estimate_items.unit_price IS 'Цена за единицу';
COMMENT ON COLUMN object_estimate_items.total_price IS 'Стоимость';
COMMENT ON COLUMN object_estimate_items.is_section IS 'Признак заголовка раздела';
