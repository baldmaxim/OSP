-- Функция для получения списка зарегистрированных пользователей из auth.users
-- Доступна через supabase.rpc('get_auth_users')
CREATE OR REPLACE FUNCTION get_auth_users()
RETURNS TABLE (
    id UUID,
    email TEXT,
    created_at TIMESTAMP WITH TIME ZONE,
    last_sign_in_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE sql
SECURITY DEFINER
AS $$
    SELECT
        au.id,
        au.email::TEXT,
        au.created_at,
        au.last_sign_in_at
    FROM auth.users au
    ORDER BY au.created_at ASC;
$$;
