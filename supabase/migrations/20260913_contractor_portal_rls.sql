-- Кабинет подрядчика: изоляция данных на стороне базы.
--
-- ПРОБЛЕМА. Кабинет показывает только «свои» тендеры, но фильтрация живёт в
-- браузере: страница подставляет организацию в запросы сама. В самой базе после
-- миграции 20260614 на тендерных таблицах стоит одна политика —
-- FOR ALL TO authenticated USING (true). То есть любой подтверждённый логин
-- подрядчика, обратившись к REST напрямую, читает тендеры, сметы и КП всех
-- остальных подрядчиков и может их изменить.
--
-- РЕШЕНИЕ. Разводим два вида подтверждённых пользователей по уже существующему
-- признаку user_roles.counterparty_id (миграция 20260815):
--   • сотрудник СУ-10 (counterparty_id IS NULL) — полный доступ, как раньше;
--   • подрядчик (counterparty_id NOT NULL) — только то, что относится к его
--     организации, и только на чтение, кроме собственного КП.
--
-- Политики пишутся ПАРАМИ на каждую таблицу: сначала «сотрудник — всё», затем
-- узкая политика подрядчика. Сотрудник ничего не теряет.
--
-- Миграция идемпотентна.

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Helper-функции. CREATE OR REPLACE — чтобы миграцию можно было применить и
--    до 20260815 (там они объявлены такими же).
CREATE OR REPLACE FUNCTION public.current_counterparty_id()
RETURNS uuid
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $fn$
  SELECT ur.counterparty_id
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid() AND ur.is_approved = true
  LIMIT 1;
$fn$;
REVOKE ALL ON FUNCTION public.current_counterparty_id() FROM public;
GRANT EXECUTE ON FUNCTION public.current_counterparty_id() TO authenticated;

-- Сотрудник СУ-10 = подтверждённый пользователь без привязки к контрагенту.
CREATE OR REPLACE FUNCTION public.is_portal_employee()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.is_approved = true
      AND ur.counterparty_id IS NULL
  );
$fn$;
REVOKE ALL ON FUNCTION public.is_portal_employee() FROM public;
GRANT EXECUTE ON FUNCTION public.is_portal_employee() TO authenticated;

-- Подрядчик приглашён в этот тендер.
CREATE OR REPLACE FUNCTION public.is_my_tender(tender_uuid uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $fn$
  SELECT public.current_counterparty_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tender_counterparties tc
    WHERE tc.tender_id = tender_uuid
      AND tc.counterparty_id = public.current_counterparty_id()
  );
$fn$;
REVOKE ALL ON FUNCTION public.is_my_tender(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_my_tender(uuid) TO authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Снимаем «всё всем подтверждённым» с тендерных таблиц и ставим пары политик.
--    Удаляем только политики, выданные роли authenticated: anon-политика
--    публичной витрины тендеров («Anon public tender list») должна остаться.
DO $mig$
DECLARE
  t text;
  p record;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenders', 'tender_counterparties', 'tender_estimate_items', 'tender_counterparty_proposals'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    FOR p IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND 'authenticated' = ANY(roles)
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY portal_employee_all ON public.%I FOR ALL TO authenticated '
      'USING (public.is_portal_employee()) WITH CHECK (public.is_portal_employee())', t);
  END LOOP;
END $mig$;

-- Подрядчик: тендеры, в которые он приглашён, — только чтение.
DROP POLICY IF EXISTS portal_contractor_select ON public.tenders;
CREATE POLICY portal_contractor_select ON public.tenders
  FOR SELECT TO authenticated
  USING (public.is_my_tender(id));

-- Участие: только своя строка. Обновлять можно (кабинет ставит «КП предоставлено»
-- после загрузки), но переписать строку на другую организацию нельзя — это
-- запрещает WITH CHECK.
DROP POLICY IF EXISTS portal_contractor_select ON public.tender_counterparties;
CREATE POLICY portal_contractor_select ON public.tender_counterparties
  FOR SELECT TO authenticated
  USING (counterparty_id = public.current_counterparty_id());

DROP POLICY IF EXISTS portal_contractor_update ON public.tender_counterparties;
CREATE POLICY portal_contractor_update ON public.tender_counterparties
  FOR UPDATE TO authenticated
  USING (counterparty_id = public.current_counterparty_id())
  WITH CHECK (counterparty_id = public.current_counterparty_id());

-- Смета (ВОР) тендера: читать по своим тендерам, менять — нельзя.
DROP POLICY IF EXISTS portal_contractor_select ON public.tender_estimate_items;
CREATE POLICY portal_contractor_select ON public.tender_estimate_items
  FOR SELECT TO authenticated
  USING (public.is_my_tender(tender_id));

-- Расценки КП: свои строки целиком (кабинет перезаписывает их при загрузке).
DROP POLICY IF EXISTS portal_contractor_select ON public.tender_counterparty_proposals;
CREATE POLICY portal_contractor_select ON public.tender_counterparty_proposals
  FOR SELECT TO authenticated
  USING (counterparty_id = public.current_counterparty_id());

DROP POLICY IF EXISTS portal_contractor_insert ON public.tender_counterparty_proposals;
CREATE POLICY portal_contractor_insert ON public.tender_counterparty_proposals
  FOR INSERT TO authenticated
  WITH CHECK (
    counterparty_id = public.current_counterparty_id()
    AND public.is_my_tender(tender_id)
  );

DROP POLICY IF EXISTS portal_contractor_delete ON public.tender_counterparty_proposals;
CREATE POLICY portal_contractor_delete ON public.tender_counterparty_proposals
  FOR DELETE TO authenticated
  USING (counterparty_id = public.current_counterparty_id());

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Справочники, без которых кабинет не отрисуется: название объекта своих
--    тендеров и своя карточка контрагента. Существующие политики этих таблиц НЕ
--    трогаем — ими пользуется весь интерфейс сотрудника.
DROP POLICY IF EXISTS portal_contractor_select ON public.objects;
CREATE POLICY portal_contractor_select ON public.objects
  FOR SELECT TO authenticated
  USING (
    public.current_counterparty_id() IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.tenders t
      JOIN public.tender_counterparties tc ON tc.tender_id = t.id
      WHERE t.object_id = objects.id
        AND tc.counterparty_id = public.current_counterparty_id()
    )
  );

DROP POLICY IF EXISTS portal_contractor_select ON public.counterparties;
CREATE POLICY portal_contractor_select ON public.counterparties
  FOR SELECT TO authenticated
  USING (id = public.current_counterparty_id());

-- ВНИМАНИЕ на будущее: политики PostgreSQL складываются по ИЛИ. Пока на
-- objects/counterparties остаётся политика вида «FOR ALL TO authenticated
-- USING (true)», добавленные выше ограничения ничего не сужают — они лишь
-- гарантируют доступ подрядчику, когда широкую политику уберут. На четырёх
-- тендерных таблицах широкая политика снята выше, поэтому изоляция там
-- действует сразу.

COMMENT ON FUNCTION public.is_portal_employee() IS
  'Подтверждённый пользователь без привязки к контрагенту = сотрудник СУ-10 (полный доступ)';
COMMENT ON FUNCTION public.is_my_tender(uuid) IS
  'Текущий пользователь — подрядчик, приглашённый в этот тендер';
