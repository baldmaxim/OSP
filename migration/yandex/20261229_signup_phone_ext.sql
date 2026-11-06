-- Добавочный номер в заявке на регистрацию подрядчика (решение пользователя 05.11.2026): телефон — «+79161234567 доб. 123», та же запись,
-- что у контактов контрагентов (src/utils/phoneFormat.js). Условие шире прежнего, прежняя служба работает с ним как раньше.
-- Порядок: migrate, затем both. Пока миграции нет, заявка с добавочным не запишется, без добавочного — проходит.
ALTER TABLE osp_auth.registrations DROP CONSTRAINT IF EXISTS registrations_phone_check;
ALTER TABLE osp_auth.registrations ADD CONSTRAINT registrations_phone_check
  CHECK (phone ~ '^\+[0-9]{8,15}( доб\. [0-9]{1,6})?$');
