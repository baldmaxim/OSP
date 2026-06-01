-- task 365: «Ориентировочный срок согласования» — дата, которую пользователь
--   проставляет после создания заявки на ДС. Тип DATE: храним голую дату
--   без timezone, чтобы избежать TZ-сдвигов при выводе DD.MM.YYYY.

ALTER TABLE dc_requests
  ADD COLUMN IF NOT EXISTS expected_approval_date DATE;

COMMENT ON COLUMN dc_requests.expected_approval_date IS
  'Ориентировочный срок согласования заявки на ДС. Заполняется после создания.';
