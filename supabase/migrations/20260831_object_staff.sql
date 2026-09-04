-- Ответственные по объекту: несколько руководителей строительства и несколько
-- экономистов вместо одного.
--
-- Миграция 20260822 завела на объекте по одному полю — objects.construction_manager_contact_id
-- и objects.economist_contact_id. На практике на объекте работают несколько
-- руководителей и несколько экономистов, и одно поле их не вмещает.
--
-- Связующая таблица, а не второе-третье поле и не массив: роли на объекте
-- будут добавляться (прораб, снабженец), и каждая новая роль в модели «поле на
-- роль» стоит очередной миграции и правки всех выборок. Тот же приём, что у
-- участников тендера (tender_counterparties) и сторон договора.
--
-- Старые поля НЕ удаляем: их значения переносятся в таблицу, а сами колонки
-- остаются как есть — на случай, если где-то остался неучтённый запрос. UI на
-- них больше не опирается.
--
-- Миграция идемпотентна.

CREATE TABLE IF NOT EXISTS object_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Роль сотрудника НА ЭТОМ ОБЪЕКТЕ. С ролью пользователя в системе не связана:
  -- один и тот же человек может быть экономистом на одном объекте и не значиться
  -- на другом.
  staff_role TEXT NOT NULL CHECK (staff_role IN ('construction_manager', 'economist')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- Один человек не может быть дважды в одной роли на одном объекте.
  CONSTRAINT object_staff_unique UNIQUE (object_id, contact_id, staff_role)
);

CREATE INDEX IF NOT EXISTS idx_object_staff_object ON object_staff(object_id, staff_role, sort_order);
CREATE INDEX IF NOT EXISTS idx_object_staff_contact ON object_staff(contact_id);

ALTER TABLE object_staff ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for authenticated users" ON object_staff;
CREATE POLICY "Allow all for authenticated users" ON object_staff
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ── Перенос уже заполненных одиночных полей ─────────────────────────────────
-- ON CONFLICT DO NOTHING делает миграцию безопасной при повторном запуске.
INSERT INTO object_staff (object_id, contact_id, staff_role, sort_order)
SELECT id, construction_manager_contact_id, 'construction_manager', 0
FROM objects
WHERE construction_manager_contact_id IS NOT NULL
ON CONFLICT ON CONSTRAINT object_staff_unique DO NOTHING;

INSERT INTO object_staff (object_id, contact_id, staff_role, sort_order)
SELECT id, economist_contact_id, 'economist', 0
FROM objects
WHERE economist_contact_id IS NOT NULL
ON CONFLICT ON CONSTRAINT object_staff_unique DO NOTHING;

COMMENT ON TABLE object_staff IS
  'Ответственные по объекту: руководители строительства и экономисты (несколько на объект)';
COMMENT ON COLUMN object_staff.staff_role IS
  'Роль на объекте: construction_manager | economist';
