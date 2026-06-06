-- Расценки от снабжения по материалам ВОР тендера (task 398).
-- Привязка к тендеру + документу-ВОР (estimate_name); сопоставление с
-- позициями ВОР по наименованию материала. Стоимость материалов от снабжения
-- = material_consumption (объём материалов в ВОР) × supply_price.
CREATE TABLE IF NOT EXISTS tender_vor_supply_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tender_id UUID REFERENCES tenders(id) ON DELETE CASCADE,
    estimate_name TEXT NOT NULL,
    material_name TEXT NOT NULL,
    unit TEXT,
    supply_price DECIMAL(15, 2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tender_id, estimate_name, material_name)
);

CREATE INDEX IF NOT EXISTS idx_tender_vor_supply_rates_tender
    ON tender_vor_supply_rates(tender_id);

CREATE OR REPLACE FUNCTION update_tender_vor_supply_rates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_tender_vor_supply_rates_updated_at ON tender_vor_supply_rates;
CREATE TRIGGER trigger_tender_vor_supply_rates_updated_at
    BEFORE UPDATE ON tender_vor_supply_rates
    FOR EACH ROW
    EXECUTE FUNCTION update_tender_vor_supply_rates_updated_at();

ALTER TABLE tender_vor_supply_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for authenticated users" ON tender_vor_supply_rates;
CREATE POLICY "Allow all for authenticated users" ON tender_vor_supply_rates
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE tender_vor_supply_rates IS 'Расценки от снабжения на материалы ВОР тендера (task 398)';
COMMENT ON COLUMN tender_vor_supply_rates.tender_id IS 'Ссылка на тендер';
COMMENT ON COLUMN tender_vor_supply_rates.estimate_name IS 'Имя ВОР-документа (estimate_name)';
COMMENT ON COLUMN tender_vor_supply_rates.material_name IS 'Наименование материала';
COMMENT ON COLUMN tender_vor_supply_rates.unit IS 'Единица измерения';
COMMENT ON COLUMN tender_vor_supply_rates.supply_price IS 'Цена от снабжения за единицу';
