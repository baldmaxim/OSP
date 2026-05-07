-- RPC для полного удаления пользователя администратором
-- Использует SECURITY DEFINER, чтобы получить доступ к auth.users.
-- Проверяет, что вызывающий — admin (через user_roles).

CREATE OR REPLACE FUNCTION admin_delete_user(target_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_caller_role TEXT;
BEGIN
    SELECT role INTO v_caller_role
    FROM public.user_roles
    WHERE user_id = auth.uid() AND is_approved = true
    LIMIT 1;

    IF v_caller_role IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'Insufficient privileges: only admin can delete users';
    END IF;

    -- Не даём админу удалить самого себя
    IF target_user_id = auth.uid() THEN
        RAISE EXCEPTION 'Cannot delete yourself';
    END IF;

    DELETE FROM public.user_roles WHERE user_id = target_user_id;
    DELETE FROM auth.users WHERE id = target_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_delete_user(UUID) TO authenticated;

COMMENT ON FUNCTION admin_delete_user IS 'Полное удаление пользователя (auth.users + user_roles). Доступно только администраторам.';
