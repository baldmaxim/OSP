-- Добавление роли 'construction_manager' (Руководитель строительства)
-- 1) Расширяем CHECK constraint в user_roles
-- 2) Расширяем CHECK constraint в role_permissions
-- 3) Добавляем дефолтные права для новой роли (за основу взяты права инженера)

ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS valid_role;
ALTER TABLE user_roles
    ADD CONSTRAINT valid_role
    CHECK (role IN ('admin', 'engineer', 'economist', 'lawyer', 'construction_manager'));

ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS valid_perm_role;
ALTER TABLE role_permissions
    ADD CONSTRAINT valid_perm_role
    CHECK (role IN ('admin', 'engineer', 'economist', 'lawyer', 'construction_manager'));

INSERT INTO role_permissions (role, section, can_view, can_edit) VALUES
    ('construction_manager', 'objects', true, true),
    ('construction_manager', 'contacts', true, true),
    ('construction_manager', 'counterparties', true, false),
    ('construction_manager', 'tenders', true, true),
    ('construction_manager', 'contracts', true, false),
    ('construction_manager', 'bsm', true, false),
    ('construction_manager', 'analysis_kp', true, false),
    ('construction_manager', 'acceptance', true, true),
    ('construction_manager', 'reports', true, true),
    ('construction_manager', 'admin', false, false)
ON CONFLICT (role, section) DO NOTHING;
