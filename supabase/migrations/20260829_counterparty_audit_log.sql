-- История изменений контрагента (зеркало dc_request_audit_log).
--
-- До сих пор правки в реестре контрагентов нигде не фиксировались: кто перевёл
-- компанию в чёрный список, кто переписал примечание, кто заменил телефон
-- контактного лица — восстановить было неоткуда. У договоров, заявок на ДС,
-- тендеров и задач такие журналы уже есть, у контрагентов не было.
--
-- Типы событий: created | field_updated | status_changed | contact_added |
-- contact_updated | contact_removed | soft_deleted | restored | imported.
-- Для field_updated/status_changed хранится пара old_value/new_value
-- (было → стало) + человекочитаемый description.
--
-- «Кто» — денормализованный снимок (changed_by_name/changed_by_role), без FK на
-- пользователя: переименование сотрудника не должно переписывать историю задним
-- числом. ON DELETE CASCADE: безвозвратное удаление контрагента уносит и его
-- историю, отдельно чистить не нужно.
--
-- Журнал заполняется С МОМЕНТА ПРИМЕНЕНИЯ: прошлые правки в базе не сохранялись
-- и восстановлению не подлежат.
--
-- Миграция идемпотентна.

CREATE TABLE IF NOT EXISTS counterparty_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  field_name TEXT,
  old_value JSONB,
  new_value JSONB,
  description TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by_role TEXT,
  changed_by_name TEXT
);

-- Лента карточки читается по контрагенту и сортируется по времени убыванием.
CREATE INDEX IF NOT EXISTS idx_counterparty_audit_log_counterparty_id
  ON counterparty_audit_log(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_counterparty_audit_log_changed_at
  ON counterparty_audit_log(changed_at DESC);

ALTER TABLE counterparty_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for authenticated users" ON counterparty_audit_log;
CREATE POLICY "Allow all for authenticated users" ON counterparty_audit_log
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE counterparty_audit_log IS
  'История изменений контрагента: поля карточки, статус, примечания, контактные лица';
