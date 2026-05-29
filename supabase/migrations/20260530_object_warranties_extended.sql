-- task 353: расширяем object_warranties под событийное начало гарантии,
--   привязку к документу-акту, фиксированную дату окончания (override) и примечание.
--
-- Идемпотентность: в одной БД таблица уже могла быть создана старой миграцией
-- 20241216_object_warranties.sql, в другой — нет (если её пропустили). Поэтому
-- сперва CREATE TABLE IF NOT EXISTS с полным набором новых полей, а затем
-- ALTER TABLE ADD COLUMN IF NOT EXISTS — для случая когда таблица уже есть в
-- старой схеме и нужно дописать только новые колонки.

-- 1) Полная схема — на случай чистой БД, где старая миграция не применялась.
CREATE TABLE IF NOT EXISTS object_warranties (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  work_name TEXT NOT NULL,
  start_date DATE,
  warranty_months INTEGER NOT NULL DEFAULT 12,
  order_number INTEGER DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- task 353: новые поля
  start_type TEXT NOT NULL DEFAULT 'date'
    CHECK (start_type IN ('date', 'event')),
  start_event_text TEXT,
  start_document_id UUID REFERENCES object_documents(id) ON DELETE SET NULL,
  end_date_override DATE,
  notes TEXT
);

-- 2) Если таблица уже была — дописываем недостающие колонки.
ALTER TABLE object_warranties
  ADD COLUMN IF NOT EXISTS start_type TEXT NOT NULL DEFAULT 'date'
    CHECK (start_type IN ('date', 'event')),
  ADD COLUMN IF NOT EXISTS start_event_text TEXT,
  ADD COLUMN IF NOT EXISTS start_document_id UUID
    REFERENCES object_documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS end_date_override DATE,
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- 3) RLS — на случай чистой БД (повторное включение безопасно).
ALTER TABLE object_warranties ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'object_warranties'
      AND policyname = 'Allow all for authenticated users'
  ) THEN
    CREATE POLICY "Allow all for authenticated users" ON object_warranties
      FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 4) Комментарии к новым колонкам.
COMMENT ON COLUMN object_warranties.start_type IS
  'date — начало по конкретной дате (start_date обязателен); event — начало по событию (start_event_text обязателен, start_date — фактическая дата когда событие наступит)';
COMMENT ON COLUMN object_warranties.start_event_text IS
  'Текст события, например «с даты подписания Акта о практическом завершении Работ по Объекту (Акт № 3)»';
COMMENT ON COLUMN object_warranties.start_document_id IS
  'Опциональная привязка к документу-акту из object_documents';
COMMENT ON COLUMN object_warranties.end_date_override IS
  'Фиксированная дата окончания — имеет приоритет над авторасчётом start_date + warranty_months';
COMMENT ON COLUMN object_warranties.notes IS
  'Примечание (последняя колонка из договорной таблицы гарантий)';
