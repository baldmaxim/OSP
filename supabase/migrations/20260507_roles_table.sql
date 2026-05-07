-- Динамические роли пользователей.
-- Раньше роли были захардкожены через CHECK-constraint на user_roles.role / role_permissions.role.
-- Теперь — отдельная таблица roles, и админ может заводить новые роли через UI без миграций.

CREATE TABLE IF NOT EXISTS roles (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    is_system BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read for authenticated" ON roles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read for anon" ON roles FOR SELECT TO anon USING (true);
CREATE POLICY "Allow write for authenticated" ON roles FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Засеваем системные роли
INSERT INTO roles (key, label, is_system) VALUES
    ('admin', 'Администратор', true),
    ('engineer', 'Инженер ОСП', true),
    ('economist', 'Экономист ОСП', true),
    ('lawyer', 'Юрист ОСП', true),
    ('construction_manager', 'Руководитель строительства', true),
    ('contractor', 'Подрядчик', true)
ON CONFLICT (key) DO NOTHING;

-- Убираем старые CHECK-constraints — теперь роли валидируются через справочную таблицу
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS valid_role;
ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS valid_perm_role;

COMMENT ON TABLE roles IS 'Справочник ролей пользователей (динамический, управляется из админки)';
COMMENT ON COLUMN roles.key IS 'Машинный ключ роли (используется в user_roles.role и role_permissions.role)';
COMMENT ON COLUMN roles.label IS 'Отображаемое название роли в UI';
COMMENT ON COLUMN roles.is_system IS 'Системные роли нельзя удалять через UI';
