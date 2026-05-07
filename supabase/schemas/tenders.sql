-- Таблица tenders (Тендеры)
CREATE TABLE IF NOT EXISTS tenders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  object_id UUID REFERENCES objects(id) ON DELETE SET NULL,
  work_description TEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'Заявка на тендер',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  tender_package_link TEXT,
  winner_counterparty_id UUID REFERENCES counterparties(id) ON DELETE SET NULL,
  responsible_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  cost_plan_link TEXT,
  cost_plan_responsible_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  summary_proposal_link TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT check_dates CHECK (end_date >= start_date)
);

-- Индексы для оптимизации запросов
CREATE INDEX IF NOT EXISTS idx_tenders_object_id ON tenders(object_id);
CREATE INDEX IF NOT EXISTS idx_tenders_status ON tenders(status);
CREATE INDEX IF NOT EXISTS idx_tenders_start_date ON tenders(start_date);
CREATE INDEX IF NOT EXISTS idx_tenders_end_date ON tenders(end_date);
CREATE INDEX IF NOT EXISTS idx_tenders_winner_counterparty_id ON tenders(winner_counterparty_id);
CREATE INDEX IF NOT EXISTS idx_tenders_responsible_contact_id ON tenders(responsible_contact_id);
CREATE INDEX IF NOT EXISTS idx_tenders_cost_plan_responsible_id ON tenders(cost_plan_responsible_id);

-- Триггер для автоматического обновления updated_at
CREATE OR REPLACE FUNCTION update_tenders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_tenders_updated_at
  BEFORE UPDATE ON tenders
  FOR EACH ROW
  EXECUTE FUNCTION update_tenders_updated_at();

-- Включение Row Level Security (RLS)
ALTER TABLE tenders ENABLE ROW LEVEL SECURITY;

-- Политики RLS (базовые - разрешить все операции для аутентифицированных пользователей)
CREATE POLICY "Enable read access for all users" ON tenders
  FOR SELECT USING (true);

CREATE POLICY "Enable insert for authenticated users" ON tenders
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Enable update for authenticated users" ON tenders
  FOR UPDATE USING (true);

CREATE POLICY "Enable delete for authenticated users" ON tenders
  FOR DELETE USING (true);

-- Комментарии к таблице и столбцам
COMMENT ON TABLE tenders IS 'Тендеры и тендерные процедуры';
COMMENT ON COLUMN tenders.id IS 'Уникальный идентификатор тендера';
COMMENT ON COLUMN tenders.object_id IS 'Ссылка на объект строительства';
COMMENT ON COLUMN tenders.work_description IS 'Описание работ';
COMMENT ON COLUMN tenders.status IS 'Статус тендера (Заявка на тендер, Подготовка ВОР, Идет тендерная процедура, Завершен, Приостановка тендера)';
COMMENT ON COLUMN tenders.start_date IS 'Дата начала тендерной процедуры';
COMMENT ON COLUMN tenders.end_date IS 'Дата окончания тендерной процедуры';
COMMENT ON COLUMN tenders.tender_package_link IS 'Ссылка на тендерный пакет';
COMMENT ON COLUMN tenders.winner_counterparty_id IS 'Контрагент-победитель тендера';
COMMENT ON COLUMN tenders.responsible_contact_id IS 'Ответственный сотрудник за тендер (из таблицы contacts)';
COMMENT ON COLUMN tenders.cost_plan_link IS 'Ссылка на план затрат (Google/Yandex Drive)';
COMMENT ON COLUMN tenders.cost_plan_responsible_id IS 'Ответственный сотрудник за план затрат (из таблицы contacts)';
COMMENT ON COLUMN tenders.summary_proposal_link IS 'Ссылка на сводную таблицу КП (Google/Yandex Drive)';
COMMENT ON COLUMN tenders.notes IS 'Примечание по тендеру (свободный текст, ведётся ответственным)';
COMMENT ON COLUMN tenders.created_at IS 'Дата и время создания записи';
COMMENT ON COLUMN tenders.updated_at IS 'Дата и время последнего обновления записи';
