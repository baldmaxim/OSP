-- Sequence для публичного порядкового номера тендера
CREATE SEQUENCE IF NOT EXISTS tenders_public_number_seq;

-- Таблица tenders (Тендеры)
CREATE TABLE IF NOT EXISTS tenders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  object_id UUID REFERENCES objects(id) ON DELETE SET NULL,
  -- Наименование объекта вручную для направления «прочее» (миграция 20260825).
  -- Используется, когда object_id пуст; в реестр objects не попадает.
  custom_object_name TEXT,
  work_description TEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'Заявка на тендер',
  start_date DATE,                     -- начало работ (подрядчик) — необязательно (task 270)
  end_date DATE,                       -- окончание работ (подрядчик) — необязательно (task 270)
  vor_start_date DATE,                 -- начало подготовки ВОР (сметный отдел)
  vor_end_date DATE,                   -- окончание подготовки ВОР
  tender_start_date DATE,              -- начало тендерной процедуры (ОСП)
  tender_end_date DATE,                -- окончание тендерной процедуры
  tender_package_link TEXT,
  winner_counterparty_id UUID REFERENCES counterparties(id) ON DELETE SET NULL,
  responsible_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- Публикация тендера в Telegram-канале (после запуска).
  tg_published BOOLEAN NOT NULL DEFAULT false,
  tg_published_at TIMESTAMPTZ,
  tg_published_by TEXT,
  -- Шаг между подведением итогов и завершением (миграция 20260830).
  completion_letter_sent BOOLEAN NOT NULL DEFAULT false,
  completion_letter_sent_at TIMESTAMPTZ,
  completion_letter_sent_by TEXT,
  cost_plan_link TEXT,
  cost_plan_responsible_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  cost_plan_status TEXT NOT NULL DEFAULT 'not_started',
  vor_link TEXT,
  vor_responsible_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  vor_status TEXT NOT NULL DEFAULT 'not_started',
  summary_proposal_link TEXT,
  notes TEXT,
  cost_plan_notes TEXT,                -- примечание для страницы «Планы затрат»
  -- Направление тендера. Раньше вычислялось из objects.status; вынесено в явное
  -- поле, потому что «совместные» и «прочее» из статуса объекта не выводятся.
  department TEXT NOT NULL DEFAULT 'construction',
  tender_type TEXT NOT NULL DEFAULT 'main',
  parent_tender_id UUID REFERENCES tenders(id) ON DELETE SET NULL,
  materials_proposal_deadline DATE,
  materials_proposal_link TEXT,
  materials_status TEXT NOT NULL DEFAULT 'not_started',
  public_tender_number INTEGER DEFAULT nextval('tenders_public_number_seq'),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT check_dates CHECK (end_date >= start_date),
  CONSTRAINT valid_cost_plan_status CHECK (cost_plan_status IN ('not_started', 'in_progress', 'completed', 'not_required')),
  CONSTRAINT valid_vor_status CHECK (vor_status IN ('not_started', 'in_progress', 'completed')),
  CONSTRAINT valid_materials_status CHECK (materials_status IN ('not_started', 'in_progress', 'completed', 'not_required')),
  CONSTRAINT valid_tender_department CHECK (department IN ('construction', 'warranty', 'joint', 'other')),
  CONSTRAINT valid_tender_type CHECK (tender_type IN ('main', 'materials')),
  CONSTRAINT tenders_parent_only_for_materials CHECK (
    (tender_type = 'materials') OR (parent_tender_id IS NULL)
  )
);

-- Индексы для оптимизации запросов
CREATE INDEX IF NOT EXISTS idx_tenders_object_id ON tenders(object_id);
CREATE INDEX IF NOT EXISTS idx_tenders_status ON tenders(status);
CREATE INDEX IF NOT EXISTS idx_tenders_start_date ON tenders(start_date);
CREATE INDEX IF NOT EXISTS idx_tenders_end_date ON tenders(end_date);
CREATE INDEX IF NOT EXISTS idx_tenders_winner_counterparty_id ON tenders(winner_counterparty_id);
CREATE INDEX IF NOT EXISTS idx_tenders_responsible_contact_id ON tenders(responsible_contact_id);
CREATE INDEX IF NOT EXISTS idx_tenders_cost_plan_responsible_id ON tenders(cost_plan_responsible_id);
CREATE INDEX IF NOT EXISTS idx_tenders_cost_plan_status ON tenders(cost_plan_status);
CREATE INDEX IF NOT EXISTS idx_tenders_vor_responsible_id ON tenders(vor_responsible_id);
CREATE INDEX IF NOT EXISTS idx_tenders_vor_status ON tenders(vor_status);
CREATE INDEX IF NOT EXISTS idx_tenders_department ON tenders(department);
CREATE INDEX IF NOT EXISTS idx_tenders_department_type ON tenders(department, tender_type);
CREATE INDEX IF NOT EXISTS idx_tenders_tender_type ON tenders(tender_type);
CREATE INDEX IF NOT EXISTS idx_tenders_parent_tender_id ON tenders(parent_tender_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenders_public_tender_number ON tenders(public_tender_number);

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
COMMENT ON COLUMN tenders.cost_plan_status IS 'Статус плана затрат: not_started | in_progress | completed | not_required';
COMMENT ON COLUMN tenders.vor_link IS 'Ссылка на ВОР (Google/Yandex Drive)';
COMMENT ON COLUMN tenders.vor_responsible_id IS 'Ответственный сотрудник за ВОР (из contacts)';
COMMENT ON COLUMN tenders.vor_status IS 'Статус ВОР: not_started | in_progress | completed';
COMMENT ON COLUMN tenders.summary_proposal_link IS 'Ссылка на сводную таблицу КП (Google/Yandex Drive)';
COMMENT ON COLUMN tenders.notes IS 'Примечание по тендеру (свободный текст, ведётся ответственным)';
COMMENT ON COLUMN tenders.department IS 'Направление: construction | warranty | joint (совместные) | other (прочее). См. миграцию 20260820_tender_departments.sql — там же триггер синхронизации со статусом объекта';
COMMENT ON COLUMN tenders.tender_type IS 'Тип тендера: main (основной — работы) | materials (тендер на закупку материалов)';
COMMENT ON COLUMN tenders.parent_tender_id IS 'Ссылка на родительский основной тендер (только для tender_type = materials)';
COMMENT ON COLUMN tenders.materials_proposal_deadline IS 'Срок предоставления КП на материалы (для tender_type = materials)';
COMMENT ON COLUMN tenders.materials_proposal_link IS 'Ссылка на КП на материалы (для tender_type = materials)';
COMMENT ON COLUMN tenders.public_tender_number IS 'Сквозной публичный номер тендера, присваивается при создании';
COMMENT ON COLUMN tenders.created_at IS 'Дата и время создания записи';
COMMENT ON COLUMN tenders.updated_at IS 'Дата и время последнего обновления записи';
