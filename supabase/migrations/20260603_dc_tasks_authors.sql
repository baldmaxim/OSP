-- task 337: трекинг авторства задач и ответов в заявках на ДС.
-- Кто поставил задачу (created_by_name) — сохраняется при insert.
-- Кто и когда ответил (responded_by_name + responded_at) — сохраняется при
-- первом изменении response_text. Имена дублируются текстом (snapshot), а не
-- FK на user_roles — пользователь мог сменить ФИО или быть удалён, а в задаче
-- важно сохранить «кто это сделал на момент действия».

ALTER TABLE dc_request_tasks ADD COLUMN IF NOT EXISTS created_by_name TEXT;
ALTER TABLE dc_request_tasks ADD COLUMN IF NOT EXISTS responded_by_name TEXT;
ALTER TABLE dc_request_tasks ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;

COMMENT ON COLUMN dc_request_tasks.created_by_name IS 'Snapshot ФИО автора задачи (task 337)';
COMMENT ON COLUMN dc_request_tasks.responded_by_name IS 'Snapshot ФИО автора ответа (task 337)';
COMMENT ON COLUMN dc_request_tasks.responded_at IS 'Момент первого сохранения ответа (task 337)';
