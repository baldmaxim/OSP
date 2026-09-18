-- Администрирование: видеть, подтвердил ли пользователь почту, и подтверждать её.
--
-- Бывает, что ссылка из письма «не срабатывает»: истёк срок жизни (по умолчанию
-- 1 час), её отменило следующее письмо (повторная регистрация) или корпоративный
-- почтовый фильтр открыл её раньше человека. Пользователь застревает на «Email не
-- подтверждён», а администратор этого даже не видел.
--
-- 1) get_auth_users отдаёт ещё email_confirmed_at. Тип результата меняется —
--    CREATE OR REPLACE так не умеет, поэтому DROP + CREATE (с той же проверкой
--    администратора, что в 20261001).
-- 2) admin_confirm_user_email(uuid) — подтвердить почту вручную. Только администратор.
--
-- Проверка администратора — как в is_admin() (20260914): подтверждённая роль admin
-- или владелец системы по e-mail; продублирована, чтобы не зависеть от 20260914.
-- Миграция идемпотентна.

DROP FUNCTION IF EXISTS public.get_auth_users();

CREATE FUNCTION public.get_auth_users()
RETURNS TABLE (
  id UUID,
  email TEXT,
  created_at TIMESTAMP WITH TIME ZONE,
  last_sign_in_at TIMESTAMP WITH TIME ZONE,
  email_confirmed_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  IF NOT (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.is_approved = true
    )
    OR EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = auth.uid() AND lower(u.email) = 'sadovnikov.d.y@su10.ru'
    )
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав: список пользователей доступен только администратору'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT au.id, au.email::TEXT, au.created_at, au.last_sign_in_at, au.email_confirmed_at
  FROM auth.users au
  ORDER BY au.created_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_auth_users() FROM public;
REVOKE ALL ON FUNCTION public.get_auth_users() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_auth_users() TO authenticated;

COMMENT ON FUNCTION public.get_auth_users() IS
  'Пользователи auth.users (с датой подтверждения почты) для «Администрирования». Только администратор.';

CREATE OR REPLACE FUNCTION public.admin_confirm_user_email(target_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  IF NOT (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin' AND ur.is_approved = true
    )
    OR EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = auth.uid() AND lower(u.email) = 'sadovnikov.d.y@su10.ru'
    )
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав: подтверждать почту может только администратор'
      USING ERRCODE = '42501';
  END IF;

  UPDATE auth.users
  SET email_confirmed_at = now()
  WHERE id = target_user_id AND email_confirmed_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_confirm_user_email(UUID) FROM public;
REVOKE ALL ON FUNCTION public.admin_confirm_user_email(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_confirm_user_email(UUID) TO authenticated;

COMMENT ON FUNCTION public.admin_confirm_user_email(UUID) IS
  'Подтвердить почту пользователя вручную (ссылка из письма не сработала). Только администратор.';
