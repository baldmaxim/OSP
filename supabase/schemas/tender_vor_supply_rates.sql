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
    -- Миграция 20261020 (расценка снабжением на сайте): как ввели и что посчитала база.
    price_input TEXT CHECK (price_input IS NULL OR price_input IN ('unit', 'total', 'import')),
    input_value NUMERIC,
    volume_at_input NUMERIC,
    supply_price_exact NUMERIC,          -- сумма / объём, когда вводили сумму; карточка считает по ней
    supply_total NUMERIC(15, 2),
    row_version INTEGER NOT NULL DEFAULT 1,
    updated_by UUID,
    material_key TEXT GENERATED ALWAYS AS (public.supply_norm_name(material_name)) STORED,
    -- Миграция 20261120: доставка позиции, как ввели (за единицу или суммой на объём); supply_price / supply_total —
    -- уже с доставкой (считает триггер расчёта).
    delivery_input TEXT,
    delivery_value NUMERIC,
    CONSTRAINT tender_vor_supply_rates_delivery_check CHECK ((delivery_input IS NULL AND delivery_value IS NULL)
      OR (delivery_input IN ('unit', 'total') AND delivery_value > 0)),
    UNIQUE(tender_id, estimate_name, material_name)
);
-- Расчёт, версия строки, закрытие после завершения тендера на материалы, журнал и права (запись — только
-- правка «Тендеров» или «Тендеров на материалы») — supabase/migrations/20261020_supply_pricing.sql.

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

-- Политики: с 20261020 — supply_rates_read (сотрудник) и supply_rates_insert/update/delete (supply_can_edit()).

COMMENT ON TABLE tender_vor_supply_rates IS 'Расценки от снабжения на материалы ВОР тендера (task 398)';
COMMENT ON COLUMN tender_vor_supply_rates.tender_id IS 'Ссылка на тендер';
COMMENT ON COLUMN tender_vor_supply_rates.estimate_name IS 'Имя ВОР-документа (estimate_name)';
COMMENT ON COLUMN tender_vor_supply_rates.material_name IS 'Наименование материала';
COMMENT ON COLUMN tender_vor_supply_rates.unit IS 'Единица измерения';
COMMENT ON COLUMN tender_vor_supply_rates.supply_price IS 'Цена от снабжения за единицу';
