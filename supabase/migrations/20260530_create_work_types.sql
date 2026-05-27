-- task 321: справочник видов работ для контрагентов.
-- Раньше «Вид работ» хранился свободным текстом (counterparties.work_type, через запятую).
-- Теперь он подтягивается из централизованного справочника, чтобы исключить
-- разнобой написаний и опечатки.

CREATE TABLE IF NOT EXISTS work_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_work_types_name ON work_types(name);

ALTER TABLE work_types ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'work_types'
      AND policyname = 'Allow all for authenticated users'
  ) THEN
    CREATE POLICY "Allow all for authenticated users" ON work_types
      FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE work_types IS 'Справочник видов работ контрагентов (task 321)';

-- Backfill: разрезаем существующие counterparties.work_type по запятым и тащим
-- уникальные значения в справочник. Дубли (case-insensitive) сворачиваем —
-- оставляем первое попавшееся написание.
INSERT INTO work_types (name)
SELECT DISTINCT TRIM(wt)
FROM counterparties,
     LATERAL unnest(string_to_array(COALESCE(work_type, ''), ',')) AS wt
WHERE wt IS NOT NULL
  AND TRIM(wt) <> ''
ON CONFLICT (name) DO NOTHING;
