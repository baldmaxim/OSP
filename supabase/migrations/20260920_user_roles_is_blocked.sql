-- Пользователи: явный признак блокировки.
--
-- Раньше статуса «заблокирован» в базе не было — он вычислялся в админке:
-- «не подтверждён (is_approved=false) и уже входил (last_login_at заполнен)».
-- «Не подтверждён и не входил» считался приглашением. Кнопка «Заблокировать»
-- только снимала is_approved, поэтому:
--   • пользователь без отметки входа сразу после блокировки показывался как
--     «Приглашён» — last_login_at пишет RPC touch_last_login (миграция 20260614),
--     и у многих он пустой;
--   • того, кто ни разу не входил, заблокировать было невозможно в принципе.
--
-- Теперь блокировка — отдельная колонка. is_approved по-прежнему единственное,
-- что открывает доступ: заблокированный всегда is_approved=false.
--
-- Миграция идемпотентна.

ALTER TABLE user_roles
  ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS blocked_by_name TEXT;

COMMENT ON COLUMN user_roles.is_blocked IS
  'Доступ заблокирован администратором (в отличие от заявки, ожидающей подтверждения). Заблокированный всегда is_approved=false';
COMMENT ON COLUMN user_roles.blocked_at IS 'Когда заблокирован';
COMMENT ON COLUMN user_roles.blocked_by_name IS 'Кто заблокировал (ФИО администратора)';

-- Перенос прежнего смысла: кого админка до сих пор показывала заблокированным
-- («не подтверждён, но входил»), остаются заблокированными — статусы на экране
-- после миграции не меняются. Повторный прогон ничего не трогает.
-- last_login_at появляется в миграции 20260614; без неё переносить нечего.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_roles' AND column_name = 'last_login_at'
  ) THEN
    UPDATE user_roles
    SET is_blocked = true
    WHERE is_approved = false
      AND last_login_at IS NOT NULL
      AND is_blocked = false
      AND blocked_at IS NULL;
  END IF;
END $$;

-- Разблокированный не может остаться подтверждённым-заблокированным: страховка
-- от рассинхрона при правках вручную.
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_blocked_not_approved;
UPDATE user_roles SET is_approved = false WHERE is_blocked = true AND is_approved = true;
ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_blocked_not_approved
  CHECK (NOT (is_blocked AND is_approved));
