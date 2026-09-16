-- Тендеры на материалы: приоритет и ответственный из отдела снабжения.
--
-- 1) materials_priority — low | medium | high (NULL = не указан). Высокий
--    приоритет выделяется в реестре.
--
-- 2) Ответственный за тендер на материалы — пользователь реестра
--    «Администрирование» с ролью снабжения (по образцу «Ответственного СТО»,
--    миграция 20260922). Раньше выбирался любой контакт из справочника
--    «Сотрудники» (tenders.responsible_contact_id).
--      materials_resp_user_id — auth.users.id, без FK;
--      materials_resp_name    — ФИО на момент назначения (для показа без чтения
--                               user_roles).
--    Прежний responsible_contact_id не удаляется: пока снабженец не назначен,
--    интерфейс показывает прежнего ответственного с пометкой.
--
-- Роль снабжения определяется по справочнику roles: название содержит «снабж»
-- или ключ начинается с «supply».
--
-- Миграция идемпотентна.

ALTER TABLE tenders
  ADD COLUMN IF NOT EXISTS materials_priority TEXT,
  ADD COLUMN IF NOT EXISTS materials_resp_user_id UUID,
  ADD COLUMN IF NOT EXISTS materials_resp_name TEXT;

ALTER TABLE tenders DROP CONSTRAINT IF EXISTS tenders_materials_priority_check;
ALTER TABLE tenders
  ADD CONSTRAINT tenders_materials_priority_check
  CHECK (materials_priority IS NULL OR materials_priority IN ('low', 'medium', 'high'));

COMMENT ON COLUMN tenders.materials_priority IS
  'Приоритет тендера на материалы: low | medium | high (NULL — не указан)';
COMMENT ON COLUMN tenders.materials_resp_user_id IS
  'Ответственный за тендер на материалы: auth.users.id пользователя с ролью снабжения';
COMMENT ON COLUMN tenders.materials_resp_name IS
  'ФИО ответственного снабженца на момент назначения';

-- ── Пользователи снабжения ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_supply_employees()
RETURNS TABLE (user_id uuid, display_name text, role text, role_label text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT ur.user_id,
         COALESCE(NULLIF(btrim(ur.full_name), ''), ur.email) AS display_name,
         ur.role,
         r.label AS role_label
  FROM public.user_roles ur
  JOIN public.roles r ON r.key = ur.role
  WHERE ur.is_approved = true
    AND ur.role <> 'contractor'
    AND ur.counterparty_id IS NULL
    AND (r.label ILIKE '%снабж%' OR r.key ILIKE 'supply%')
    AND EXISTS (
      SELECT 1 FROM public.user_roles me
      WHERE me.user_id = auth.uid()
        AND me.is_approved = true
        AND me.role <> 'contractor'
    )
  ORDER BY 2;
$fn$;

REVOKE ALL ON FUNCTION public.list_supply_employees() FROM public;
REVOKE ALL ON FUNCTION public.list_supply_employees() FROM anon;
GRANT EXECUTE ON FUNCTION public.list_supply_employees() TO authenticated;

COMMENT ON FUNCTION public.list_supply_employees() IS
  'Сотрудники отдела снабжения (роль с «снабж» в названии или ключом supply*) для выбора ответственного за тендер на материалы';

-- ── Перенос назначенных ответственных ──────────────────────────────────────
-- Только тендеры на материалы и только однозначное совпадение ФИО контакта с
-- пользователем снабжения.
UPDATE tenders t
SET materials_resp_user_id = m.user_id,
    materials_resp_name = m.display_name
FROM (
  SELECT c.id AS contact_id,
         (array_agg(s.user_id))[1] AS user_id,
         (array_agg(s.display_name))[1] AS display_name
  FROM contacts c
  JOIN (
    SELECT ur.user_id,
           COALESCE(NULLIF(btrim(ur.full_name), ''), ur.email) AS display_name,
           lower(regexp_replace(btrim(ur.full_name), '\s+', ' ', 'g')) AS name_key
    FROM user_roles ur
    JOIN roles r ON r.key = ur.role
    WHERE ur.is_approved = true
      AND ur.role <> 'contractor'
      AND ur.counterparty_id IS NULL
      AND (r.label ILIKE '%снабж%' OR r.key ILIKE 'supply%')
      AND NULLIF(btrim(ur.full_name), '') IS NOT NULL
  ) s ON s.name_key = lower(regexp_replace(btrim(c.full_name), '\s+', ' ', 'g'))
  GROUP BY c.id
  HAVING count(DISTINCT s.user_id) = 1
) m
WHERE t.responsible_contact_id = m.contact_id
  AND t.tender_type = 'materials'
  AND t.materials_resp_user_id IS NULL;
