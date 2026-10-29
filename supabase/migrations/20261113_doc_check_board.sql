-- «Заявки на проверку ДП/ДС»: доска по образцу той, на которой отдел ведёт проверку сейчас (решение пользователя
-- 29.10.2026 — «примерно такую же, как на фото»).
--
--  • assignee_ids — исполнители (id пользователей, как employee_directory.user_id); на карточке — кружки с инициалами;
--  • due_date — срок; просроченная незавершённая заявка обведена красным;
--  • priority — high | normal | low, NULL — не указан;
--  • color — цвет карточки: red | orange | yellow | green | teal | blue | violet | pink, NULL — без цвета;
--  • labels — метки («Переподписание», «В бумажном виде», «Направлены правки»…), свободный текст, до 12;
--  • archived_at — в архиве: заявка уходит с доски, видна во вкладке «Архив»;
--  • статус tax_clause — колонка «Проверка документов (исключение налоговой оговорки)».
-- «Сводка по ДП» — не статус: колонка-выборка на странице (src/utils/docCheckHelpers.js), в базе её нет.
--
-- Права не меняются: колонки той же таблицы doc_check_requests. Только добавление и расширение списка статусов,
-- повтор безопасен. База нового портала (Яндекс) — migration/yandex/20261113_doc_check_board.sql.
-- Проверка: migration/backup/checks/20261113.sql; откат — migration/rollback/20261113_doc_check_board_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.doc_check_requests
  ADD COLUMN IF NOT EXISTS assignee_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS priority text,
  ADD COLUMN IF NOT EXISTS color text,
  ADD COLUMN IF NOT EXISTS labels text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_status_check;
ALTER TABLE public.doc_check_requests ADD CONSTRAINT doc_check_requests_status_check
  CHECK (status IN ('new', 'in_progress', 'edo', 'signal', 'accounting', 'done', 'awaiting_scan', 'tax_clause'));

ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_priority_check;
ALTER TABLE public.doc_check_requests ADD CONSTRAINT doc_check_requests_priority_check
  CHECK (priority IS NULL OR priority IN ('high', 'normal', 'low'));

ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_color_check;
ALTER TABLE public.doc_check_requests ADD CONSTRAINT doc_check_requests_color_check
  CHECK (color IS NULL OR color IN ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink'));

ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_labels_check;
ALTER TABLE public.doc_check_requests ADD CONSTRAINT doc_check_requests_labels_check
  CHECK (cardinality(labels) <= 12);

ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_assignees_check;
ALTER TABLE public.doc_check_requests ADD CONSTRAINT doc_check_requests_assignees_check
  CHECK (cardinality(assignee_ids) <= 20);

COMMENT ON COLUMN public.doc_check_requests.status IS
  'new | in_progress | edo (выгрузка по ЭДО) | signal (загрузка в Signal) | accounting (загрузка в 1С) | done | awaiting_scan (ждём подписанный бумажный оригинал) | tax_clause (проверка документов: исключение налоговой оговорки)';
COMMENT ON COLUMN public.doc_check_requests.assignee_ids IS 'Исполнители — id пользователей (employee_directory.user_id)';
COMMENT ON COLUMN public.doc_check_requests.due_date IS 'Срок заявки';
COMMENT ON COLUMN public.doc_check_requests.priority IS 'Приоритет: high | normal | low, NULL — не указан';
COMMENT ON COLUMN public.doc_check_requests.color IS 'Цвет карточки на доске: red | orange | yellow | green | teal | blue | violet | pink';
COMMENT ON COLUMN public.doc_check_requests.labels IS 'Метки карточки (свободный текст), до 12';
COMMENT ON COLUMN public.doc_check_requests.archived_at IS 'В архиве с этого момента: заявки нет на доске, она во вкладке «Архив»';

COMMIT;
