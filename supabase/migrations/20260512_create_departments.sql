-- Справочник отделов компании. Используется на вкладке «Отделы» в разделе
-- «Контактные данные» (ContactsPage).

CREATE TABLE IF NOT EXISTS departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_departments_name ON departments(name);

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON departments
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE departments IS 'Справочник отделов компании';
