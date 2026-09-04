-- Ответственные по объекту (несколько на объект).
-- Источник истины — supabase/migrations/20260831_object_staff.sql.
--
-- Заменяет одиночные objects.construction_manager_contact_id /
-- objects.economist_contact_id (миграция 20260822): те колонки остались в
-- таблице, но UI их больше не читает и не пишет.
CREATE TABLE IF NOT EXISTS object_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  staff_role TEXT NOT NULL CHECK (staff_role IN ('construction_manager', 'economist')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT object_staff_unique UNIQUE (object_id, contact_id, staff_role)
);

CREATE INDEX IF NOT EXISTS idx_object_staff_object ON object_staff(object_id, staff_role, sort_order);
CREATE INDEX IF NOT EXISTS idx_object_staff_contact ON object_staff(contact_id);

ALTER TABLE object_staff ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON object_staff
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
