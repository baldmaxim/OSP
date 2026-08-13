-- Задача: импорт договоров из Excel + постоянный ID портала + Тип ДП/ДС + новые поля.
-- Все изменения обратно совместимы: существующие договоры не пересоздаются и не меняют данные.

-- 1) Компактный постоянный ID портала (display_id), независимый от contract_number.
--    UUID (id) уникален, но не компактен и неудобен для показа/поиска в реестре.
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS display_id BIGINT;

-- Бэкфилл существующих строк в хронологическом порядке (created_at, затем id как tiebreak).
-- Данные строк при этом не меняются — заполняется только новый служебный столбец.
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at NULLS FIRST, id) AS rn
  FROM contracts
)
UPDATE contracts c
SET display_id = o.rn
FROM ordered o
WHERE c.id = o.id AND c.display_id IS NULL;

-- Последовательность владеет будущими значениями; стартует после текущего максимума.
-- Последовательность только растёт → удалённый номер не переиспользуется; пропуски допустимы.
CREATE SEQUENCE IF NOT EXISTS contracts_display_id_seq OWNED BY contracts.display_id;
SELECT setval('contracts_display_id_seq', COALESCE((SELECT MAX(display_id) FROM contracts), 0) + 1, false);
ALTER TABLE contracts ALTER COLUMN display_id SET DEFAULT nextval('contracts_display_id_seq');
ALTER TABLE contracts ALTER COLUMN display_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contracts_display_id_key'
  ) THEN
    ALTER TABLE contracts ADD CONSTRAINT contracts_display_id_key UNIQUE (display_id);
  END IF;
END $$;

-- 2) Тип записи ДП/ДС. NOT NULL DEFAULT 'dp' → все существующие строки становятся ДП.
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS record_type TEXT NOT NULL DEFAULT 'dp'
  CHECK (record_type IN ('dp', 'ds'));

-- 3) Ссылка на родительский договор для будущих ДС.
--    Это НЕ уникальный ID самого ДС — у ДС будет собственный display_id.
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS parent_contract_id UUID
  REFERENCES contracts(id) ON DELETE SET NULL;

-- 4) Новые свободные текстовые поля договора (без справочников и валидации).
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS gen_director_name TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS bsm TEXT,
  ADD COLUMN IF NOT EXISTS comments TEXT;

-- 5) Разрешаем одинаковые номера договоров: по ТЗ допускается второй самостоятельный
--    ДП с тем же номером (и одинаковые № с разными ID). Уникальность записи теперь
--    обеспечивает display_id, а не contract_number. Не-уникальный индекс для поиска
--    (idx_contracts_contract_number) остаётся ниже/уже создан.
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_contract_number_key;

CREATE INDEX IF NOT EXISTS idx_contracts_display_id ON contracts(display_id);
CREATE INDEX IF NOT EXISTS idx_contracts_record_type ON contracts(record_type);
CREATE INDEX IF NOT EXISTS idx_contracts_parent_contract_id ON contracts(parent_contract_id);
CREATE INDEX IF NOT EXISTS idx_contracts_contract_number ON contracts(contract_number);

COMMENT ON COLUMN contracts.display_id IS 'Постоянный компактный ID портала (авто, уникален, не переиспользуется)';
COMMENT ON COLUMN contracts.record_type IS 'Тип записи: dp — основной договор (ДП), ds — доп. соглашение (ДС)';
COMMENT ON COLUMN contracts.parent_contract_id IS 'Родительский договор для ДС (не является ID самого ДС)';
COMMENT ON COLUMN contracts.gen_director_name IS 'ФИО генерального директора (свободный текст)';
COMMENT ON COLUMN contracts.phone IS 'Телефон (свободный текст)';
COMMENT ON COLUMN contracts.email IS 'Email (свободный текст)';
COMMENT ON COLUMN contracts.bsm IS 'БСМ (свободный текст: да/нет/частично/любое)';
COMMENT ON COLUMN contracts.comments IS 'Комментарии (свободный текст)';
