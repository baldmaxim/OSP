-- Таблица актуальных расценок от снабжения по материалам для объектов
CREATE TABLE IF NOT EXISTS bsm_supply_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_id UUID REFERENCES objects(id) ON DELETE CASCADE,
    material_name TEXT NOT NULL,
    unit TEXT,
    supply_price DECIMAL(15, 2) NOT NULL,
    applied_at DATE,  -- Дата применения расценки (необязательное поле)
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    -- Уникальное ограничение: один материал - одна расценка для объекта
    UNIQUE(object_id, material_name)
);

-- Триггер для автообновления updated_at
CREATE OR REPLACE FUNCTION update_bsm_supply_rates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_bsm_supply_rates_updated_at ON bsm_supply_rates;
CREATE TRIGGER trigger_bsm_supply_rates_updated_at
    BEFORE UPDATE ON bsm_supply_rates
    FOR EACH ROW
    EXECUTE FUNCTION update_bsm_supply_rates_updated_at();

-- RLS политики
ALTER TABLE bsm_supply_rates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON bsm_supply_rates
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- Комментарии
COMMENT ON TABLE bsm_supply_rates IS 'Актуальные расценки от снабжения на материалы по объектам';
COMMENT ON COLUMN bsm_supply_rates.object_id IS 'Ссылка на объект';
COMMENT ON COLUMN bsm_supply_rates.material_name IS 'Наименование материала';
COMMENT ON COLUMN bsm_supply_rates.unit IS 'Единица измерения';
COMMENT ON COLUMN bsm_supply_rates.supply_price IS 'Актуальная цена от снабжения';
COMMENT ON COLUMN bsm_supply_rates.applied_at IS 'Дата применения расценки';
COMMENT ON COLUMN bsm_supply_rates.notes IS 'Примечания';
