-- task 364: гарантийное удержание может выплачиваться частями (1/3 с даты А,
--   2/3 с даты Б, и т.п.). Текущая модель object_warranty_retentions хранит
--   только один retention_period для всего удержания — это не годится.
--
-- Решение: дочерняя таблица object_warranty_retention_payments, где каждая
-- строка — одна часть выплаты с долей (portion_text, например «1/3») и
-- описанием условия (condition_text). Сортировка по order_number.
--
-- На самом удержании остаются поля retention_percent, retention_period,
-- notes — общий процент, общий срок удержания и сноски/комментарии.
--
-- Идемпотентность: в БД могла отсутствовать родительская таблица
-- object_warranty_retentions (если старую миграцию 20241216_object_warranties.sql
-- не применяли). Поэтому сперва CREATE TABLE IF NOT EXISTS для неё + RLS,
-- затем дочерняя таблица.

-- 1) Родительская таблица — на случай чистой БД.
CREATE TABLE IF NOT EXISTS object_warranty_retentions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  retention_percent DECIMAL(5, 2) NOT NULL DEFAULT 0,
  retention_period TEXT,
  notes TEXT,
  order_number INTEGER DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE object_warranty_retentions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'object_warranty_retentions'
      AND policyname = 'Allow all for authenticated users'
  ) THEN
    CREATE POLICY "Allow all for authenticated users" ON object_warranty_retentions
      FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 2) Дочерняя таблица — части выплаты.
CREATE TABLE IF NOT EXISTS object_warranty_retention_payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  retention_id UUID NOT NULL REFERENCES object_warranty_retentions(id) ON DELETE CASCADE,
  portion_text TEXT NOT NULL,        -- '1/3', '2/3', '100%', '50%'…
  condition_text TEXT NOT NULL,      -- описание условия / события выплаты
  order_number INTEGER DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_owrp_retention_id
  ON object_warranty_retention_payments(retention_id);

ALTER TABLE object_warranty_retention_payments ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'object_warranty_retention_payments'
      AND policyname = 'Allow all for authenticated users'
  ) THEN
    CREATE POLICY "Allow all for authenticated users" ON object_warranty_retention_payments
      FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE object_warranty_retention_payments IS
  'Части выплаты гарантийного удержания (1/3 с даты А, 2/3 с даты Б и т.п.). FK на object_warranty_retentions с ON DELETE CASCADE.';
COMMENT ON COLUMN object_warranty_retention_payments.portion_text IS
  'Доля от суммы удержания: «1/3», «2/3», «100%», «50%»';
COMMENT ON COLUMN object_warranty_retention_payments.condition_text IS
  'Описание условия выплаты, например «с даты получения Разрешения на ввод объекта в эксплуатацию»';
