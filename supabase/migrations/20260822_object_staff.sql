-- Ответственные сотрудники объекта: руководитель строительства и экономист.
--
-- До сих пор связь «объект → сотрудник» была только обратной: contacts.object_id
-- показывал, к какому объекту приписан человек. Понять из карточки объекта, кто
-- на нём руководитель строительства, а кто экономист, было нельзя — в реестре
-- сотрудников на объект приписаны и инженеры, и мастера, и снабженцы.
--
-- Ссылаемся на contacts (реестр сотрудников), а не на user_roles: сотрудник
-- необязательно имеет логин на сайте — см. миграцию 20260725, где эти сущности
-- сознательно разведены. Тендеры ссылаются на contacts тем же способом
-- (responsible_contact_id).
--
-- ON DELETE SET NULL: удаление человека из реестра не должно ронять объект —
-- поле просто опустеет.
--
-- Миграция идемпотентна.

ALTER TABLE objects
  ADD COLUMN IF NOT EXISTS construction_manager_contact_id UUID
    REFERENCES contacts(id) ON DELETE SET NULL;

ALTER TABLE objects
  ADD COLUMN IF NOT EXISTS economist_contact_id UUID
    REFERENCES contacts(id) ON DELETE SET NULL;

COMMENT ON COLUMN objects.construction_manager_contact_id IS
  'Руководитель строительства объекта (ссылка на реестр сотрудников contacts)';
COMMENT ON COLUMN objects.economist_contact_id IS
  'Экономист объекта (ссылка на реестр сотрудников contacts)';

CREATE INDEX IF NOT EXISTS idx_objects_construction_manager
  ON objects(construction_manager_contact_id);
CREATE INDEX IF NOT EXISTS idx_objects_economist
  ON objects(economist_contact_id);
