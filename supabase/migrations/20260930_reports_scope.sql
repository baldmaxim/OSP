-- «Отчёты»: право на все вкладки + открытие отчётов для «Сметный отдел_Руководители».
--
-- Новый раздел прав reports_full («Отчёты: все вкладки»). С ним «Отчёты» выглядят
-- как раньше (Тендеры, Победители, Материалы, Планы затрат, ВОРы и РД, Договоры).
-- Без него — только отчёты рабочих разделов роли: «ВОРы и РД» (при праве на
-- «ВОРы и РД» или «Тендеры») и «Тендеры на материалы».
--
-- 1) Всем ролям, у которых отчёты уже открыты, выдаём reports_full — для них
--    ничего не меняется. Повторный прогон ручные настройки не трогает.
-- 2) Роли «Сметный отдел_Руководители» открываем «Отчёты» и «ВОРы и РД», но без
--    reports_full: в отчётах у неё только «ВОРы и РД». Роль ищется по названию
--    (ключ заводился в админке), пробелы/подчёркивания и регистр не важны.
--
-- Настройка дальше — в «Администрирование → Права доступа».
-- Миграция идемпотентна.

-- ── 2) Сначала целевая роль: ей reports_full явно выключаем ────────────────
INSERT INTO role_permissions (role, section, can_view, can_edit)
SELECT r.key, s.section, s.can_view, false
FROM roles r
CROSS JOIN (VALUES ('reports', true), ('vors', true), ('reports_full', false)) AS s(section, can_view)
WHERE lower(regexp_replace(r.label, '[\s_]+', ' ', 'g')) = 'сметный отдел руководители'
ON CONFLICT (role, section) DO UPDATE
  SET can_view = true
  -- «Отчёты» и «ВОРы и РД» открываем; reports_full при повторном прогоне не
  -- трогаем — вдруг администратор включил его вручную.
  WHERE role_permissions.section IN ('reports', 'vors');

-- ── 1) Остальным ролям с отчётами — все вкладки, как было ─────────────────
INSERT INTO role_permissions (role, section, can_view, can_edit)
SELECT rp.role, 'reports_full', true, false
FROM role_permissions rp
WHERE rp.section = 'reports' AND rp.can_view = true
ON CONFLICT (role, section) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM roles
    WHERE lower(regexp_replace(label, '[\s_]+', ' ', 'g')) = 'сметный отдел руководители'
  ) THEN
    RAISE NOTICE 'Роль «Сметный отдел_Руководители» не найдена — отчёты ей не открыты, настройте в «Права доступа»';
  END IF;
END $$;
