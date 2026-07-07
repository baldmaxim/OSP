-- Задача 419: сопутствующие приложения договора, добавляемые вручную в раскрытом блоке
-- реестра «Договоры и ДС». Отдельная сущность от привязанных приложений объекта
-- (contract_attachments): здесь юрист сам заводит строки с №, наименованием,
-- ответственным и статусом.
CREATE TABLE IF NOT EXISTS contract_appendices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  appendix_number TEXT,            -- № приложения (по умолчанию авто, можно менять вручную)
  name TEXT,                       -- наименование приложения
  responsible TEXT,                -- ответственный
  status TEXT,                     -- статус
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contract_appendices_contract ON contract_appendices(contract_id);

ALTER TABLE contract_appendices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON contract_appendices
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
