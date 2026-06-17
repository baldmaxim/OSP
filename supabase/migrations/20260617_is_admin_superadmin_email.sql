-- task: защита суперадмина от RLS-самоблокировки.
--
-- Проблема: is_admin() (миграция 20260614) проверяет ТОЛЬКО user_roles.role = 'admin'.
-- Если суперадмин случайно сменил себе роль в БД, is_admin() возвращает false и политика
-- user_roles_update_admin блокирует ему любую правку ролей — вернуть admin из UI невозможно.
--
-- Решение: is_admin() дополнительно возвращает true, если текущий пользователь — суперадмин
-- по email. Функция SECURITY DEFINER → читает auth.users в обход RLS. Так суперадмин всегда
-- проходит проверку на запись в user_roles и не может заблокировать сам себя.
--
-- ВАЖНО: список email ниже должен совпадать с SUPER_ADMINS в src/contexts/RoleContext.jsx.

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role = 'admin'
      and ur.is_approved = true
  )
  or exists (
    select 1
    from auth.users u
    where u.id = auth.uid()
      and lower(u.email) = 'sadovnikov.d.y@su10.ru'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;
