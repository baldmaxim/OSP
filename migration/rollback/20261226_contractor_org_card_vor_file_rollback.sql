-- АВАРИЙНЫЙ ОТКАТ 20261226_contractor_org_card_vor_file (только база Яндекса): карточка компании — прежние поля (тело 20261204), файл ВОР
-- подрядчику с регистрации снова не отдаётся (маршрут отвечает ошибкой). Страница работает: без новых полей нет строки с номером,
-- НДС и контактных лиц. Данные не затрагиваются. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.bid_vor_file(uuid);
DROP FUNCTION IF EXISTS public.contractor_org_card();
CREATE FUNCTION public.contractor_org_card()
RETURNS TABLE (name text, inn text, kpp text, legal_address text, actual_address text, website text, work_type text,
               contact_name text, contact_phone text, contact_email text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT c.name::text, c.inn::text, c.kpp::text, c.legal_address::text, c.actual_address::text, c.website::text, c.work_type::text,
         ur.full_name::text, ur.work_phone::text, ur.email::text
  FROM public.user_roles ur
  JOIN public.counterparties c ON c.id = ur.counterparty_id AND c.deleted_at IS NULL
  WHERE ur.user_id = auth.uid() AND ur.is_approved AND NOT ur.is_blocked
$$;
COMMENT ON FUNCTION public.contractor_org_card() IS 'Кабинет подрядчика: сведения о своей организации и контакт учётки, поля — перечнем.';

COMMIT;
