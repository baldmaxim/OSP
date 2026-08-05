-- Добавляем «Застройщик» к объекту (Общая информация → Объекты → Информация).
-- Отображается в карточке объекта под наименованием и в шапке детальной страницы.
ALTER TABLE objects
  ADD COLUMN IF NOT EXISTS developer VARCHAR(255);

COMMENT ON COLUMN objects.developer IS 'Застройщик объекта';
