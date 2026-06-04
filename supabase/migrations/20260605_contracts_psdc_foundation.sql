-- Модуль «Договоры» — фундамент (задачи 374/375–389)
-- 1) Расширение contracts: валюта, ставка НДС, режим хранения суммы.
-- 2) Новая таблица contract_psdc_items (ПСДЦ, одна на договор; импорт из Excel).
--    Колонки agreement_id/change_type/target_item_id зарезервированы под ДС (дельта-модель).
-- 3) Новая таблица contract_advance_schedule (график авансирования).

-- =========================================================================
-- 1. contracts: новые поля
-- =========================================================================
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'RUB',
  ADD COLUMN IF NOT EXISTS vat_rate DECIMAL(5, 2),
  ADD COLUMN IF NOT EXISTS amount_includes_vat BOOLEAN NOT NULL DEFAULT true;

-- Сумма договора может отсутствовать до импорта ПСДЦ — снимаем NOT NULL, CHECK сохраняем.
ALTER TABLE contracts ALTER COLUMN contract_amount DROP NOT NULL;

COMMENT ON COLUMN contracts.currency IS 'Валюта договора (ISO 4217): RUB/CNY/USD/EUR';
COMMENT ON COLUMN contracts.vat_rate IS 'Ставка НДС договора, % (0/5/22/…); зависит от системы налогообложения контрагента';
COMMENT ON COLUMN contracts.amount_includes_vat IS 'TRUE — суммы/цены заданы с НДС, FALSE — без НДС';

-- =========================================================================
-- 2. contract_psdc_items — ПСДЦ (Проект сметы договорной цены / ВОР)
-- =========================================================================
CREATE TABLE IF NOT EXISTS contract_psdc_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  -- Резерв под ДС (фаза 2, дельта-модель): для базовых строк всё NULL.
  agreement_id UUID,
  change_type VARCHAR(10),          -- 'add' | 'modify' | 'remove' (NULL = базовая строка ПСДЦ)
  target_item_id UUID,              -- ссылка на изменяемую/удаляемую базовую строку
  -- Содержимое строки
  row_number INTEGER,
  code VARCHAR(50),
  cost_name TEXT,
  unit VARCHAR(50),
  quantity DECIMAL(15, 4),
  unit_price_materials DECIMAL(15, 2) DEFAULT 0,
  unit_price_works DECIMAL(15, 2) DEFAULT 0,
  unit_price DECIMAL(15, 2) DEFAULT 0,
  total_price DECIMAL(15, 2) DEFAULT 0,
  vat_percent DECIMAL(5, 2) DEFAULT 0,
  is_davalchesky BOOLEAN DEFAULT false,   -- давальческий материал: объём учитываем, сумму НЕТ
  is_section BOOLEAN DEFAULT false,
  original_row_number VARCHAR(20),
  notes TEXT,
  import_mode VARCHAR(20) DEFAULT 'separate',   -- 'separate' | 'combined'
  is_approved BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Уникальность базовых строк (для строк ДС agreement_id IS NOT NULL — не ограничиваем).
CREATE UNIQUE INDEX IF NOT EXISTS uq_psdc_base_row
  ON contract_psdc_items(contract_id, row_number)
  WHERE agreement_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_psdc_contract_id ON contract_psdc_items(contract_id);

CREATE OR REPLACE FUNCTION update_contract_psdc_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_contract_psdc_items_updated_at ON contract_psdc_items;
CREATE TRIGGER trigger_update_contract_psdc_items_updated_at
  BEFORE UPDATE ON contract_psdc_items
  FOR EACH ROW
  EXECUTE FUNCTION update_contract_psdc_items_updated_at();

ALTER TABLE contract_psdc_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated users on contract_psdc_items" ON contract_psdc_items
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE contract_psdc_items IS 'ПСДЦ договора — строки сметы договорной цены (контроль объёмов и сумм)';
COMMENT ON COLUMN contract_psdc_items.agreement_id IS 'Резерв под ДС: строка относится к ДС (NULL = базовая ПСДЦ договора)';
COMMENT ON COLUMN contract_psdc_items.change_type IS 'Резерв под ДС: тип изменения строки add/modify/remove';
COMMENT ON COLUMN contract_psdc_items.is_davalchesky IS 'Давальческий материал: объём отображается, в сумму договора не входит';

-- =========================================================================
-- 3. contract_advance_schedule — график авансирования
-- =========================================================================
CREATE TABLE IF NOT EXISTS contract_advance_schedule (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  planned_date DATE,
  amount DECIMAL(15, 2),
  description TEXT,
  paid_date DATE,            -- факт выдачи (необязательно; полноценные оплаты — следующий этап)
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advance_contract_id ON contract_advance_schedule(contract_id);

CREATE OR REPLACE FUNCTION update_contract_advance_schedule_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_contract_advance_schedule_updated_at ON contract_advance_schedule;
CREATE TRIGGER trigger_update_contract_advance_schedule_updated_at
  BEFORE UPDATE ON contract_advance_schedule
  FOR EACH ROW
  EXECUTE FUNCTION update_contract_advance_schedule_updated_at();

ALTER TABLE contract_advance_schedule ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated users on contract_advance_schedule" ON contract_advance_schedule
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE contract_advance_schedule IS 'График авансирования договора: в определённые даты — определённые суммы';
