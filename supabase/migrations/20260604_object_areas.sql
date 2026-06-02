-- task 372: список площадей объекта вместо одного поля «Общая площадь».
-- Каждая площадь: тип, значение, ед. изм., источник данных, методика/основание.
-- Поддержка вложенных подпунктов через self-reference parent_area_id
-- (например: «Общая площадь здания» → «Корпус 1 / Корпус 2 / Корпус 3»).

CREATE TABLE IF NOT EXISTS object_areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  parent_area_id UUID REFERENCES object_areas(id) ON DELETE CASCADE,
  area_type TEXT NOT NULL,          -- тип / название площади
  value NUMERIC(14, 2),             -- числовое значение
  unit TEXT DEFAULT 'м²',           -- единица измерения (по умолчанию м²)
  data_source TEXT,                 -- источник данных (проект, БТИ, МГЭ, ПТО…)
  calc_method TEXT,                 -- методика / основание расчёта
  notes TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_object_areas_object ON object_areas(object_id);
CREATE INDEX IF NOT EXISTS idx_object_areas_parent ON object_areas(parent_area_id);

ALTER TABLE object_areas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON object_areas
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
