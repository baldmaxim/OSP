-- task 333: добавляем раздел 'dc_requests' (Заявка на ДС) в права ролей.
-- До этого секция была невидима в админке (SECTIONS в RoleContext не знал про неё),
-- и пункт сайдбара показывался всем сотрудникам без проверки прав. Теперь — гейт
-- через canView('dc_requests'), а админ может управлять видимостью из интерфейса.

INSERT INTO role_permissions (role, section, can_view, can_edit) VALUES
  ('admin', 'dc_requests', true, true),
  ('engineer', 'dc_requests', true, true),
  ('economist', 'dc_requests', true, true),
  ('lawyer', 'dc_requests', true, false),
  ('construction_manager', 'dc_requests', true, true)
ON CONFLICT (role, section) DO NOTHING;
