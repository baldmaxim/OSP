-- Тип ENUM для статусов объектов
CREATE TYPE object_status AS ENUM ('main_construction', 'warranty_service');

-- Таблица объектов строительства
CREATE TABLE IF NOT EXISTS objects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  address TEXT NOT NULL,
  description TEXT,
  map_link TEXT,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  status object_status DEFAULT 'main_construction',
  planned_start_date DATE,              -- Планируемая дата начала работ
  planned_end_date DATE,                -- Планируемая дата окончания работ
  total_area DECIMAL(12, 2),            -- Общая площадь объекта (м²)
  budget DECIMAL(15, 2),                -- Бюджет объекта (руб.)
  cover_image_url TEXT,                 -- Ссылка на обложку/фото объекта (Supabase Storage)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Таблица контактов (руководители, экономисты, инженеры)
CREATE TABLE IF NOT EXISTS contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  full_name VARCHAR(255) NOT NULL,
  position VARCHAR(100) NOT NULL,
  phone VARCHAR(50),
  email VARCHAR(255),
  object_id UUID REFERENCES objects(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_objects_name ON objects(name);
CREATE INDEX IF NOT EXISTS idx_objects_coordinates ON objects(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_objects_status ON objects(status);
CREATE INDEX IF NOT EXISTS idx_contacts_full_name ON contacts(full_name);
CREATE INDEX IF NOT EXISTS idx_contacts_position ON contacts(position);
CREATE INDEX IF NOT EXISTS idx_contacts_object_id ON contacts(object_id);

-- Функция для автоматического обновления updated_at в таблице objects
CREATE OR REPLACE FUNCTION update_objects_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Функция для автоматического обновления updated_at в таблице contacts
CREATE OR REPLACE FUNCTION update_contacts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Триггер для автоматического обновления updated_at в таблице objects
CREATE TRIGGER trigger_update_objects_updated_at
  BEFORE UPDATE ON objects
  FOR EACH ROW
  EXECUTE FUNCTION update_objects_updated_at();

-- Триггер для автоматического обновления updated_at в таблице contacts
CREATE TRIGGER trigger_update_contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION update_contacts_updated_at();

-- Enable Row Level Security
ALTER TABLE objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

-- Политики RLS (базовые - разрешить все операции для всех пользователей)
CREATE POLICY "Enable read access for all users on objects" ON objects
  FOR SELECT USING (true);

CREATE POLICY "Enable insert for authenticated users on objects" ON objects
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Enable update for authenticated users on objects" ON objects
  FOR UPDATE USING (true);

CREATE POLICY "Enable delete for authenticated users on objects" ON objects
  FOR DELETE USING (true);

CREATE POLICY "Enable read access for all users on contacts" ON contacts
  FOR SELECT USING (true);

CREATE POLICY "Enable insert for authenticated users on contacts" ON contacts
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Enable update for authenticated users on contacts" ON contacts
  FOR UPDATE USING (true);

CREATE POLICY "Enable delete for authenticated users on contacts" ON contacts
  FOR DELETE USING (true);

-- Комментарии к таблицам и столбцам
COMMENT ON TABLE objects IS 'Объекты строительства';
COMMENT ON COLUMN objects.id IS 'Уникальный идентификатор объекта';
COMMENT ON COLUMN objects.name IS 'Название объекта';
COMMENT ON COLUMN objects.address IS 'Адрес объекта';
COMMENT ON COLUMN objects.description IS 'Описание объекта';
COMMENT ON COLUMN objects.map_link IS 'Ссылка на карту (Google Maps, Yandex Maps и т.д.)';
COMMENT ON COLUMN objects.latitude IS 'Широта объекта (latitude) в десятичных градусах';
COMMENT ON COLUMN objects.longitude IS 'Долгота объекта (longitude) в десятичных градусах';
COMMENT ON COLUMN objects.status IS 'Статус объекта: основное строительство или гарантийное обслуживание';
COMMENT ON COLUMN objects.planned_start_date IS 'Планируемая дата начала работ';
COMMENT ON COLUMN objects.planned_end_date IS 'Планируемая дата окончания работ';
COMMENT ON COLUMN objects.total_area IS 'Общая площадь объекта в м²';
COMMENT ON COLUMN objects.budget IS 'Бюджет объекта в рублях';
COMMENT ON COLUMN objects.created_at IS 'Дата и время создания записи';
COMMENT ON COLUMN objects.updated_at IS 'Дата и время последнего обновления записи';

COMMENT ON TABLE contacts IS 'Контакты (руководители, экономисты, инженеры)';
COMMENT ON COLUMN contacts.id IS 'Уникальный идентификатор контакта';
COMMENT ON COLUMN contacts.full_name IS 'ФИО контакта';
COMMENT ON COLUMN contacts.position IS 'Должность';
COMMENT ON COLUMN contacts.phone IS 'Телефон';
COMMENT ON COLUMN contacts.email IS 'Email';
COMMENT ON COLUMN contacts.object_id IS 'Ссылка на объект строительства';
COMMENT ON COLUMN contacts.created_at IS 'Дата и время создания записи';
COMMENT ON COLUMN contacts.updated_at IS 'Дата и время последнего обновления записи';
