-- get_auth_users: только для администратора.
--
-- Функция (миграция 20241225) — SECURITY DEFINER над auth.users без проверки
-- вызывающего: любой вошедший пользователь, включая подрядчика, мог вызвать
-- supabase.rpc('get_auth_users') и получить e-mail и даты входа всех
-- пользователей системы. Нужна она только странице «Администрирование».
--
-- Проверка — та же, что в is_admin() (20260914): подтверждённая роль admin или
-- владелец системы по e-mail. Логика продублирована, чтобы миграция не зависела
-- от того, применена ли 20260914.
--
-- Миграция идемпотентна.

CREATE OR REPLACE FUNCTION public.get_auth_users()
RETURNS TABLE (
  id UUID,
  email TEXT,
  created_at TIMESTAMP WITH TIME ZONE,
  last_sign_in_at TIMESTAMP WITH TIME ZONE
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
  SELECT au.id, au.email::TEXT, au.created_at, au.last_sign_in_at
  FROM auth.users au
  ORDER BY au.created_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_auth_users() FROM public;
REVOKE ALL ON FUNCTION public.get_auth_users() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_auth_users() TO authenticated;

COMMENT ON FUNCTION public.get_auth_users() IS
  'Пользователи auth.users для страницы «Администрирование». Только администратор (20261001).';
