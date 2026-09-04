-- Шифры рабочей документации (РД) по тендеру.
--
-- В тендере фигурируют разделы РД со своими шифрами (АР, КЖ, ОВ и т.д.).
-- Раньше их держали в описании работ или в переписке — найти, по какому шифру
-- идёт тендер, было негде.
--
-- Отдельная таблица, а не поле в tenders: шифров у тендера обычно несколько,
-- у каждого своё наименование раздела и примечание.
--
-- Миграция идемпотентна.

CREATE TABLE IF NOT EXISTS tender_rd_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  -- Сам шифр, как он записан в документации: «2024-15-АР».
  code TEXT NOT NULL,
  -- Наименование раздела РД: «Архитектурные решения».
  title TEXT,
  notes TEXT,
  -- Ручной порядок строк: шифры перечисляют в принятой последовательности
  -- разделов, а не по алфавиту. Шаг 10 — запас под вставку между строками.
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_tender_rd_codes_tender
  ON tender_rd_codes(tender_id, sort_order);

ALTER TABLE tender_rd_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for authenticated users" ON tender_rd_codes;
CREATE POLICY "Allow all for authenticated users" ON tender_rd_codes
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE tender_rd_codes IS
  'Шифры рабочей документации по тендеру (несколько на тендер)';
COMMENT ON COLUMN tender_rd_codes.code IS 'Шифр РД, как в документации (например 2024-15-АР)';
COMMENT ON COLUMN tender_rd_codes.title IS 'Наименование раздела РД';
