-- Роли пользователей
CREATE TABLE IF NOT EXISTS user_roles (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'engineer',
    is_approved BOOLEAN NOT NULL DEFAULT false,
    email TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT valid_role CHECK (role IN ('admin', 'engineer', 'economist', 'lawyer'))
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON user_roles FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON user_roles FOR ALL TO anon USING (true) WITH CHECK (true);

-- Права ролей по разделам (настраиваемые администратором)
CREATE TABLE IF NOT EXISTS role_permissions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    role TEXT NOT NULL,
    section TEXT NOT NULL,
    can_view BOOLEAN NOT NULL DEFAULT true,
    can_edit BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT valid_perm_role CHECK (role IN ('admin', 'engineer', 'economist', 'lawyer')),
    CONSTRAINT unique_role_section UNIQUE (role, section)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON role_permissions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON role_permissions FOR ALL TO anon USING (true) WITH CHECK (true);

-- Начальные права
INSERT INTO role_permissions (role, section, can_view, can_edit) VALUES
    ('admin', 'objects', true, true),
    ('admin', 'contacts', true, true),
    ('admin', 'counterparties', true, true),
    ('admin', 'tenders', true, true),
    ('admin', 'contracts', true, true),
    ('admin', 'bsm', true, true),
    ('admin', 'analysis_kp', true, true),
    ('admin', 'acceptance', true, true),
    ('admin', 'reports', true, true),
    ('admin', 'admin', true, true),
    ('engineer', 'objects', true, true),
    ('engineer', 'contacts', true, true),
    ('engineer', 'counterparties', true, true),
    ('engineer', 'tenders', true, true),
    ('engineer', 'contracts', true, false),
    ('engineer', 'bsm', true, true),
    ('engineer', 'analysis_kp', true, true),
    ('engineer', 'acceptance', true, true),
    ('engineer', 'reports', true, false),
    ('engineer', 'admin', false, false),
    ('economist', 'objects', true, false),
    ('economist', 'contacts', true, false),
    ('economist', 'counterparties', true, false),
    ('economist', 'tenders', true, true),
    ('economist', 'contracts', true, true),
    ('economist', 'bsm', true, true),
    ('economist', 'analysis_kp', true, true),
    ('economist', 'acceptance', true, false),
    ('economist', 'reports', true, true),
    ('economist', 'admin', false, false),
    ('lawyer', 'objects', true, false),
    ('lawyer', 'contacts', true, false),
    ('lawyer', 'counterparties', true, false),
    ('lawyer', 'tenders', true, false),
    ('lawyer', 'contracts', true, true),
    ('lawyer', 'bsm', false, false),
    ('lawyer', 'analysis_kp', false, false),
    ('lawyer', 'acceptance', true, false),
    ('lawyer', 'reports', true, false),
    ('lawyer', 'admin', false, false);
