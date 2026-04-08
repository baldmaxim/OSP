-- Таблица плана затрат по объекту
CREATE TABLE IF NOT EXISTS object_cost_plan (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  category VARCHAR(255) NOT NULL,        -- Категория затрат
  estimated_amount DECIMAL(15, 2) DEFAULT 0, -- Плановая сумма
  actual_amount DECIMAL(15, 2) DEFAULT 0,    -- Фактическая сумма
  order_number INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_object_cost_plan_object_id ON object_cost_plan(object_id);

-- Триггер для автоматического обновления updated_at
CREATE OR REPLACE FUNCTION update_object_cost_plan_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_object_cost_plan_updated_at
  BEFORE UPDATE ON object_cost_plan
  FOR EACH ROW
  EXECUTE FUNCTION update_object_cost_plan_updated_at();

-- Enable Row Level Security
ALTER TABLE object_cost_plan ENABLE ROW LEVEL SECURITY;

-- RLS политики
CREATE POLICY "Allow all for authenticated users on object_cost_plan" ON object_cost_plan
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Комментарии
COMMENT ON TABLE object_cost_plan IS 'План затрат по объекту';
COMMENT ON COLUMN object_cost_plan.category IS 'Категория/статья затрат';
COMMENT ON COLUMN object_cost_plan.estimated_amount IS 'Плановая сумма';
COMMENT ON COLUMN object_cost_plan.actual_amount IS 'Фактическая сумма';
