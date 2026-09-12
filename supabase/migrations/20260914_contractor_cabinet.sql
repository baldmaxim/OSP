-- Кабинет подрядчика: доступ к своим договорам и документам тендера + защита
-- саморегистрации. Продолжение 20260913 (там закрыты тендерные таблицы).
--
-- Что закрывается здесь:
--   1) Саморегистрация не должна позволять выдать себе роль. Политика
--      user_roles_insert_self_pending (20260614) требовала лишь is_approved=false,
--      а роль в строке заявитель писал сам. Администратор, нажимая «Подтвердить»,
--      просто ставит is_approved=true — и самозаявленная роль становится рабочей.
--   2) Подрядчику нужны СВОИ договоры и документы своих тендеров/договоров, но
--      s3_documents и contracts до сих пор открыты всем подтверждённым логинам.
--
-- Миграция идемпотентна. Сотрудник (user_roles.counterparty_id IS NULL) ничего
-- не теряет: ему везде выдаётся прежний полный доступ отдельной политикой.

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Саморегистрация: только безопасные роли.
--
-- 'contractor' — заявка подрядчика из кабинета, 'engineer' — заявка сотрудника
-- (значение по умолчанию в форме регистрации). Всё остальное, включая 'admin',
-- назначает только администратор, у которого своя INSERT/UPDATE-политика.
--
-- Блок самодостаточен: если 20260614/20260617 по какой-то причине не применены,
-- он сам создаёт is_admin() и полный строгий набор политик user_roles. Иначе
-- ограничение роли ничего не давало бы — оставшаяся политика «всё всем
-- подтверждённым» разрешает вставку по ИЛИ.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.is_approved = true
  )
  OR EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = auth.uid() AND lower(u.email) = 'sadovnikov.d.y@su10.ru'
  );
$fn$;
REVOKE ALL ON FUNCTION public.is_admin() FROM public;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- Широкие политики на таблице ролей недопустимы: через них пользователь сам себе
-- меняет роль. Сносим всё, что выдано authenticated, и пересоздаём строгий набор.
DO $roles$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_roles' AND 'authenticated' = ANY(roles)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.user_roles', p.policyname);
  END LOOP;
END $roles$;

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_roles_select_self_or_admin" ON user_roles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY "user_roles_insert_self_pending" ON user_roles
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND is_approved = false
    AND role IN ('contractor', 'engineer')
  );

CREATE POLICY "user_roles_insert_admin" ON user_roles
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "user_roles_update_admin" ON user_roles
  FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "user_roles_delete_admin" ON user_roles
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- Компания, которую заявитель указал при саморегистрации. Справочник контрагентов
-- публично не показываем (это коммерческая информация), поэтому подрядчик пишет
-- название и ИНН текстом, а администратор связывает заявку с реальной карточкой
-- контрагента (user_roles.counterparty_id) при подтверждении.
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS requested_company TEXT;
COMMENT ON COLUMN user_roles.requested_company IS
  'Организация, указанная подрядчиком при регистрации (название + ИНН, свободный текст). Служит подсказкой администратору для привязки counterparty_id';

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Вспомогательные функции (CREATE OR REPLACE — совместимо с 20260815/20260913).
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

-- Договор «мой», если организация — сторона договора (основная или в списке сторон).
CREATE OR REPLACE FUNCTION public.is_my_contract(contract_uuid uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $fn$
  SELECT public.current_counterparty_id() IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE c.id = contract_uuid AND c.counterparty_id = public.current_counterparty_id()
    )
    OR EXISTS (
      SELECT 1 FROM public.contract_counterparties cc
      WHERE cc.contract_id = contract_uuid AND cc.counterparty_id = public.current_counterparty_id()
    )
  );
$fn$;
REVOKE ALL ON FUNCTION public.is_my_contract(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_my_contract(uuid) TO authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Договоры и стороны договора: сотруднику — всё, подрядчику — только свои,
--    только на чтение. Удалённые (soft-delete) подрядчику не показываем.
DO $mig$
DECLARE
  t text;
  p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['contracts', 'contract_counterparties', 's3_documents'] LOOP
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

DROP POLICY IF EXISTS portal_contractor_select ON public.contracts;
CREATE POLICY portal_contractor_select ON public.contracts
  FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND public.is_my_contract(id));

DROP POLICY IF EXISTS portal_contractor_select ON public.contract_counterparties;
CREATE POLICY portal_contractor_select ON public.contract_counterparties
  FOR SELECT TO authenticated
  USING (counterparty_id = public.current_counterparty_id());

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Файлы. Подрядчик видит:
--      • тендерный пакет и ВОР/РД своих тендеров — по ним он готовит КП;
--      • документы своих договоров (включая текст для согласования).
--    Всё остальное содержимое бакета для него не существует. Edge-функция
--    s3-presign подписывает ссылку, только если строка видна вызывающему, —
--    то есть эта политика заодно закрывает и скачивание файлов.
DROP POLICY IF EXISTS portal_contractor_select ON public.s3_documents;
CREATE POLICY portal_contractor_select ON public.s3_documents
  FOR SELECT TO authenticated
  USING (
    (owner_type = 'tender'
      AND doc_category IN ('tender_package', 'vor')
      AND public.is_my_tender(owner_id))
    OR (owner_type = 'contract' AND public.is_my_contract(owner_id))
  );

COMMENT ON POLICY portal_contractor_select ON public.s3_documents IS
  'Подрядчик: тендерный пакет и ВОР своих тендеров + документы своих договоров';

-- ────────────────────────────────────────────────────────────────────────────
-- 5) Индексы под проверки принадлежности (их дёргает каждая строка политики).
CREATE INDEX IF NOT EXISTS idx_tender_counterparties_cp_tender
  ON tender_counterparties (counterparty_id, tender_id);
CREATE INDEX IF NOT EXISTS idx_contract_counterparties_cp_contract
  ON contract_counterparties (counterparty_id, contract_id);
CREATE INDEX IF NOT EXISTS idx_s3_documents_owner
  ON s3_documents (owner_type, owner_id);
