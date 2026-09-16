-- Раздел прав «Тендеры на материалы» (tenders_materials).
--
-- По образцу раздела «ВОРы и РД» (миграция 20260921): отделу снабжения нужен
-- только этот список, а сами тендеры основного строительства, участники, КП и
-- карточка тендера — закрыты.
--
-- Для существующих ролей копируем права раздела «Тендеры»: у тех, кто работал
-- с тендерами на материалы, ничего не меняется. Повторный прогон и ручные
-- настройки администратора не затрагиваются (ON CONFLICT DO NOTHING).

INSERT INTO role_permissions (role, section, can_view, can_edit)
SELECT rp.role, 'tenders_materials', rp.can_view, rp.can_edit
FROM role_permissions rp
WHERE rp.section = 'tenders'
ON CONFLICT (role, section) DO NOTHING;
