-- Справочник должностей сотрудников + телефон у сотрудника теперь необязательный.

-- 1) Справочник должностей (аналогично departments)
CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_positions_name ON positions(name);

ALTER TABLE positions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'positions'
      AND policyname = 'Allow all for authenticated users'
  ) THEN
    CREATE POLICY "Allow all for authenticated users" ON positions
      FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE positions IS 'Справочник должностей сотрудников';

-- 2) Телефон у contacts теперь необязательный
ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;
