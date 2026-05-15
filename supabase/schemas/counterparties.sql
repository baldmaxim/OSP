-- ENUM для статуса контрагента
CREATE TYPE counterparty_status AS ENUM ('active', 'blacklist');

-- Таблица counterparties (Контрагенты/Подрядчики)
CREATE TABLE IF NOT EXISTS counterparties (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  work_type VARCHAR(255),
  inn VARCHAR(12),
  kpp VARCHAR(9),
  legal_address TEXT,
  actual_address TEXT,
  website VARCHAR(500),
  status counterparty_status DEFAULT 'active',
  notes TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Индексы для оптимизации запросов
CREATE INDEX IF NOT EXISTS idx_counterparties_name ON counterparties(name);
CREATE INDEX IF NOT EXISTS idx_counterparties_inn ON counterparties(inn);
CREATE INDEX IF NOT EXISTS idx_counterparties_deleted_at ON counterparties(deleted_at);

-- Триггер для автоматического обновления updated_at
CREATE OR REPLACE FUNCTION update_counterparties_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_counterparties_updated_at
  BEFORE UPDATE ON counterparties
  FOR EACH ROW
  EXECUTE FUNCTION update_counterparties_updated_at();

-- Включение Row Level Security (RLS)
ALTER TABLE counterparties ENABLE ROW LEVEL SECURITY;

-- Политики RLS (базовые - разрешить все операции для аутентифицированных пользователей)
CREATE POLICY "Enable read access for all users" ON counterparties
  FOR SELECT USING (true);

CREATE POLICY "Enable insert for authenticated users" ON counterparties
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Enable update for authenticated users" ON counterparties
  FOR UPDATE USING (true);

CREATE POLICY "Enable delete for authenticated users" ON counterparties
  FOR DELETE USING (true);

-- Комментарии к таблице и столбцам
COMMENT ON TABLE counterparties IS 'Справочник контрагентов (подрядчиков)';
COMMENT ON COLUMN counterparties.id IS 'Уникальный идентификатор контрагента';
COMMENT ON COLUMN counterparties.name IS 'Наименование организации';
COMMENT ON COLUMN counterparties.work_type IS 'Вид работ контрагента';
COMMENT ON COLUMN counterparties.inn IS 'ИНН (Идентификационный номер налогоплательщика)';
COMMENT ON COLUMN counterparties.kpp IS 'КПП (Код причины постановки на учет)';
COMMENT ON COLUMN counterparties.legal_address IS 'Юридический адрес';
COMMENT ON COLUMN counterparties.actual_address IS 'Фактический адрес';
COMMENT ON COLUMN counterparties.website IS 'Ссылка на сайт контрагента';
COMMENT ON COLUMN counterparties.status IS 'Статус контрагента (действующий/черный список)';
COMMENT ON COLUMN counterparties.notes IS 'Примечания к контрагенту';
COMMENT ON COLUMN counterparties.created_at IS 'Дата и время создания записи';
COMMENT ON COLUMN counterparties.updated_at IS 'Дата и время последнего обновления записи';
