-- Задача 419: «Приложения к Договору» (ручной ввод в раскрытом блоке реестра).
CREATE TABLE IF NOT EXISTS contract_appendices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  appendix_number TEXT,            -- № приложения: ручной override; NULL — авто
  number_manual BOOLEAN DEFAULT false, -- true — номер задан вручную
  parent_id UUID REFERENCES contract_appendices(id) ON DELETE CASCADE, -- подпункт №N.1
  name TEXT,                       -- наименование приложения
  responsible TEXT,                -- ответственный
  status TEXT,                     -- статус
  notes TEXT,                      -- примечание юриста по статусу приложения
  sort_order INTEGER DEFAULT 0,    -- порядок среди соседей одного уровня
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contract_appendices_contract ON contract_appendices(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_appendices_parent ON contract_appendices(parent_id);

ALTER TABLE contract_appendices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON contract_appendices
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
