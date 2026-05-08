-- Привязка пользователя к объекту (или к офису).
-- object_id IS NULL = офисный сотрудник, видит все объекты.
-- object_id IS NOT NULL = сотрудник объекта, видит только свой объект.
-- Админ всегда видит всё, независимо от значения.

ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS object_id UUID REFERENCES objects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_roles_object_id ON user_roles(object_id);

COMMENT ON COLUMN user_roles.object_id IS 'Объект, к которому прикреплён пользователь. NULL = офис (видит все объекты)';
