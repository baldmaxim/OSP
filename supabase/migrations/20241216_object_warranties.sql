-- Таблица гарантийных сроков объекта
CREATE TABLE IF NOT EXISTS object_warranties (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  work_name TEXT NOT NULL,
  start_date DATE,
  warranty_months INTEGER NOT NULL DEFAULT 12,
  order_number INTEGER DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Таблица гарантийных удержаний объекта
CREATE TABLE IF NOT EXISTS object_warranty_retentions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  retention_percent DECIMAL(5, 2) NOT NULL DEFAULT 0,
  retention_period TEXT,
  notes TEXT,
  order_number INTEGER DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- RLS
ALTER TABLE object_warranties ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated users" ON object_warranties
    FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

ALTER TABLE object_warranty_retentions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated users" ON object_warranty_retentions
    FOR ALL TO authenticated
    USING (true) WITH CHECK (true);
