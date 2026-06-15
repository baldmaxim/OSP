-- Фикс: админ не мог подтвердить заявку на регистрацию.
--
-- Симптом: при нажатии «Подтвердить» в Администрировании —
--   «new row violates row-level security policy for table "user_roles"».
--
-- Причина: заявка на регистрацию — это auth-пользователь без строки в user_roles,
-- поэтому AdminPage.handleApprove делает INSERT строки для ЧУЖОГО user_id с
-- is_approved = true. Миграция 20260614_fix_rls_public_access.sql добавила
-- админские политики только для UPDATE и DELETE; единственная INSERT-политика —
-- user_roles_insert_self_pending (user_id = auth.uid() AND is_approved = false) —
-- разрешает лишь саморегистрацию. Админской INSERT-политики не было.
--
-- Решение: добавить недостающую INSERT-политику для админа. Политики пермиссивные
-- (объединяются по OR), поэтому саморегистрация (user_roles_insert_self_pending)
-- продолжает работать, а подтверждённый админ (is_admin()) может вставлять строки
-- для любых пользователей (подтверждение заявок, ручное назначение роли).

drop policy if exists "user_roles_insert_admin" on user_roles;
create policy "user_roles_insert_admin" on user_roles
  for insert to authenticated
  with check (public.is_admin());
