-- Справочник видов работ контрагентов (task 321).
-- Источник истины для дропдауна «Виды работ» в карточке контрагента.

CREATE TABLE work_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_work_types_name ON work_types(name);

ALTER TABLE work_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON work_types
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
