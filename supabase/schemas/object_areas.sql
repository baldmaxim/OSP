-- Reference schema for «Площади объекта» (task 372).
-- See migration 20260604_object_areas.sql for the authoritative DDL.
--
-- Список площадей объекта с вложенными подпунктами (parent_area_id self-reference).

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
