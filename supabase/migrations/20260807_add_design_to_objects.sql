-- Проектирование объекта (проектная организация): «СУ-10» либо иная. Заполняется во
-- вкладке «Информация» объекта; отображается в карточке объекта. Параллель с developer.
ALTER TABLE objects
  ADD COLUMN IF NOT EXISTS design VARCHAR(255);

COMMENT ON COLUMN objects.design IS 'Проектирование (проектная организация)';
