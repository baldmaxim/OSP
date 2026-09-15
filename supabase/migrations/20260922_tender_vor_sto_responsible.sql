-- ВОРы и РД: «Ответственный СТО» — пользователь из реестра «Администрирование»
-- с ролью сметно-технического отдела.
--
-- Раньше ответственный за ВОРы и РД (tenders.vor_responsible_id) выбирался из
-- справочника «Сотрудники» (таблица contacts) — любого человека. Теперь его
-- выбирают только среди пользователей сайта с ролью СТО: это те, кто сам работает
-- в разделе «ВОРы и РД».
--
--   vor_sto_user_id — auth.users.id (без FK, как user_roles.user_id и задачи);
--   vor_sto_name    — ФИО на момент назначения: показывается в реестрах, отчётах
--                     и карточке без чтения user_roles (его RLS отдаёт сотруднику
--                     только собственную строку).
--
-- Старое поле vor_responsible_id не удаляется: если СТО ещё не назначен, в
-- интерфейсе показывается прежний ответственный с пометкой «не из реестра СТО».
--
-- Роль СТО определяется по справочнику roles: название содержит «сметн»
-- («Сметно-технический отдел») или ключ начинается с «sto». Отдельного признака
-- у роли нет — роль заводит администратор с произвольным ключом.
--
-- Миграция идемпотентна.

ALTER TABLE tenders
  ADD COLUMN IF NOT EXISTS vor_sto_user_id UUID,
  ADD COLUMN IF NOT EXISTS vor_sto_name TEXT;

COMMENT ON COLUMN tenders.vor_sto_user_id IS
  'Ответственный СТО за ВОРы и РД: auth.users.id пользователя с ролью сметно-технического отдела';
COMMENT ON COLUMN tenders.vor_sto_name IS
  'ФИО ответственного СТО на момент назначения (для показа без чтения user_roles)';

CREATE INDEX IF NOT EXISTS idx_tenders_vor_sto_user ON tenders (vor_sto_user_id);

-- ── Пользователи СТО ────────────────────────────────────────────────────────
-- SECURITY DEFINER: обычный сотрудник не может читать чужие строки user_roles.
-- Отдаём только ФИО и роль подтверждённых сотрудников СТО и только сотруднику
-- (не подрядчику).
CREATE OR REPLACE FUNCTION public.list_sto_employees()
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
    AND (r.label ILIKE '%сметн%' OR r.key ILIKE 'sto%')
    AND EXISTS (
      SELECT 1 FROM public.user_roles me
      WHERE me.user_id = auth.uid()
        AND me.is_approved = true
        AND me.role <> 'contractor'
    )
  ORDER BY 2;
$fn$;

REVOKE ALL ON FUNCTION public.list_sto_employees() FROM public;
REVOKE ALL ON FUNCTION public.list_sto_employees() FROM anon;
GRANT EXECUTE ON FUNCTION public.list_sto_employees() TO authenticated;

COMMENT ON FUNCTION public.list_sto_employees() IS
  'Сотрудники сметно-технического отдела (роль с «сметн» в названии или ключом sto*) для выбора ответственного СТО';

-- ── Перенос назначенных ответственных ──────────────────────────────────────
-- Если прежний ответственный (контакт) по ФИО однозначно совпадает с
-- пользователем СТО — переносим. Неоднозначные и несовпавшие не трогаем: их
-- переназначат вручную, прежнее имя пока видно с пометкой.
UPDATE tenders t
SET vor_sto_user_id = m.user_id,
    vor_sto_name = m.display_name
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
      AND (r.label ILIKE '%сметн%' OR r.key ILIKE 'sto%')
      AND NULLIF(btrim(ur.full_name), '') IS NOT NULL
  ) s ON s.name_key = lower(regexp_replace(btrim(c.full_name), '\s+', ' ', 'g'))
  GROUP BY c.id
  HAVING count(DISTINCT s.user_id) = 1
) m
WHERE t.vor_responsible_id = m.contact_id
  AND t.vor_sto_user_id IS NULL;
