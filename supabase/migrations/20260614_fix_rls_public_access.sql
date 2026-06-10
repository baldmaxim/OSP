-- task: КРИТИЧЕСКИЙ фикс RLS — закрыть anon-доступ к внутренним таблицам.
--
-- Проблема: многие политики названы «для authenticated», но без TO authenticated
-- применяются к PUBLIC (включая anon). Плюс явные опасные политики FOR ALL TO anon на
-- user_roles / role_permissions / roles / counterparty_relations / object_estimate_items.
-- Через публичный anon-key можно было читать/менять внутренние данные, роли и права.
--
-- Решение (адаптивное — работает по фактическому состоянию pg_policies в БД):
--   1) is_admin() + touch_last_login() (SECURITY DEFINER).
--   2) RLS включён на всех таблицах public.
--   3) С НЕ-ролевых таблиц снимаются все политики, выданные public/anon (кроме явных
--      read-only для публичной страницы тендеров), и гарантируется единая политика
--      FOR ALL TO authenticated (модель приложения: authenticated = полный доступ).
--   4) Публичные тендеры/объекты — строго ограниченные SELECT TO anon.
--   5) Ролевые таблицы (user_roles/role_permissions/roles) — строгие политики:
--      чтение своего/справочника, запись только админам, самоназначение роли запрещено.

-- ────────────────────────────────────────────────────────────────────────────
-- 0) Проверка администратора. SECURITY DEFINER → читает user_roles в обход RLS,
--    поэтому НЕТ рекурсии при использовании в политике самой user_roles.
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
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Обновление last_login_at без выдачи authenticated широкого UPDATE на user_roles.
create or replace function public.touch_last_login()
returns void
language sql
security definer
set search_path = public
as $$
  update public.user_roles set last_login_at = now() where user_id = auth.uid();
$$;
revoke all on function public.touch_last_login() from public;
grant execute on function public.touch_last_login() to authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Включаем RLS на всех таблицах схемы public (без RLS таблица открыта всем,
--    кому выданы grant'ы, в т.ч. anon).
do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', r.relname);
  end loop;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Снимаем все политики с ролевых таблиц (пересоздадим строгие ниже).
do $$
declare r record;
begin
  for r in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('user_roles', 'role_permissions', 'roles')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Generic sweep по НЕ-ролевым таблицам: убрать все политики, выданные public/anon
--    (кроме явных публичных read-only тендеров/объектов), и гарантировать единую
--    политику FOR ALL TO authenticated.
do $$
declare
  keep_public text[] := array['Anon public tender list', 'Anon public objects via open tenders'];
  role_tables text[] := array['user_roles', 'role_permissions', 'roles'];
  r record;
begin
  -- 3a) Удаляем небезопасные (public/anon) политики.
  for r in
    select tablename, policyname, roles from pg_policies where schemaname = 'public'
  loop
    if r.tablename = any(role_tables) then continue; end if;
    if r.policyname = any(keep_public) then continue; end if;
    if ('public' = any(r.roles)) or ('anon' = any(r.roles)) then
      execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
    end if;
  end loop;

  -- 3b) Гарантируем authenticated-доступ на каждой RLS-таблице (кроме ролевых) —
  --     иначе включённый RLS без политики заблокирует и сотрудников.
  for r in
    select c.relname as t
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      and c.relname <> all(role_tables)
  loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = r.t and 'authenticated' = any(roles)
    ) then
      execute format(
        'create policy %I on public.%I for all to authenticated using (true) with check (true)',
        'rls_authenticated_all', r.t);
    end if;
  end loop;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Публичная страница тендеров — строго ограниченный read-only anon-доступ.
drop policy if exists "Anon public tender list" on tenders;
create policy "Anon public tender list" on tenders
  for select to anon
  using (
    status = 'Идет тендерная процедура'
    and deleted_at is null
    and (tender_type is null or tender_type = 'main')
  );

drop policy if exists "Anon public objects via open tenders" on objects;
create policy "Anon public objects via open tenders" on objects
  for select to anon
  using (
    exists (
      select 1 from tenders t
      where t.object_id = objects.id
        and t.status = 'Идет тендерная процедура'
        and t.deleted_at is null
        and (t.tender_type is null or t.tender_type = 'main')
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 5) Ролевые таблицы — строгие политики (только authenticated; anon закрыт).

-- user_roles: видит свою запись (или админ — все); регистрация = вставка только
-- СВОЕЙ записи в статусе «не подтверждён» (нельзя самому себе выдать доступ);
-- изменение/удаление — только админ. last_login_at идёт через touch_last_login().
create policy "user_roles_select_self_or_admin" on user_roles
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy "user_roles_insert_self_pending" on user_roles
  for insert to authenticated
  with check (user_id = auth.uid() and is_approved = false);
create policy "user_roles_update_admin" on user_roles
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "user_roles_delete_admin" on user_roles
  for delete to authenticated
  using (public.is_admin());

-- role_permissions: матрицу прав читают все authenticated (нужно фронту), правит админ.
create policy "role_permissions_select_auth" on role_permissions
  for select to authenticated using (true);
create policy "role_permissions_modify_admin" on role_permissions
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- roles: справочник ролей читают все authenticated, правит админ.
create policy "roles_select_auth" on roles
  for select to authenticated using (true);
create policy "roles_modify_admin" on roles
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
