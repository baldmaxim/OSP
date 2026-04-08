-- Добавление столбца "дата применения расценки" в таблицу bsm_supply_rates
-- Поле необязательное (NULL), используется для отслеживания когда расценка была применена

ALTER TABLE bsm_supply_rates
ADD COLUMN IF NOT EXISTS applied_at DATE;

-- Комментарий к столбцу
COMMENT ON COLUMN bsm_supply_rates.applied_at IS 'Дата применения расценки (когда расценка была использована)';
