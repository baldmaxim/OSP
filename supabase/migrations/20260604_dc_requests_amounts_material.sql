-- task 370: суммы ДС (Было/Стало) + тип материала.
-- amount_before / amount_after — стоимость ДС «на входе» и после обработки (с НДС 22%).
-- material_type — давальческие (М-15) или реализация.

ALTER TABLE dc_requests
  ADD COLUMN IF NOT EXISTS amount_before NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS amount_after  NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS material_type TEXT
    CHECK (material_type IN ('tolling', 'realization'));
