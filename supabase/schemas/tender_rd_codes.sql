-- Шифры рабочей документации (РД) по тендеру.
-- Источник истины — supabase/migrations/20260901_tender_rd_codes.sql.
CREATE TABLE IF NOT EXISTS tender_rd_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  title TEXT,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_tender_rd_codes_tender ON tender_rd_codes(tender_id, sort_order);

ALTER TABLE tender_rd_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON tender_rd_codes
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
