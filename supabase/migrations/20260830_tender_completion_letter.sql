-- Тендеры: отметка «письмо о завершении отправлено участникам».
--
-- Между «Подведением итогов» и «Завершен» есть шаг, который нигде не
-- фиксировался: всем участвовавшим подрядчикам рассылают письмо о том, что
-- тендер закрыт. По карточке нельзя было понять, разослали его или нет, и
-- проигравшие подрядчики оставались без ответа.
--
-- Отдельный статус заводить не стали: это не стадия тендера, а признак
-- выполненного действия — по образцу tg_published (миграция 20260806).
-- Флаг + кто/когда, чтобы в карточке было видно не только «отправлено», но и кем.
--
-- Миграция идемпотентна.

ALTER TABLE tenders
  ADD COLUMN IF NOT EXISTS completion_letter_sent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenders
  ADD COLUMN IF NOT EXISTS completion_letter_sent_at TIMESTAMPTZ;
ALTER TABLE tenders
  ADD COLUMN IF NOT EXISTS completion_letter_sent_by TEXT;

COMMENT ON COLUMN tenders.completion_letter_sent IS
  'Письмо о завершении тендера разослано всем участникам (шаг между подведением итогов и завершением)';
COMMENT ON COLUMN tenders.completion_letter_sent_at IS
  'Когда отмечена рассылка письма о завершении тендера';
COMMENT ON COLUMN tenders.completion_letter_sent_by IS
  'Кто отметил рассылку письма о завершении тендера (ФИО на момент отметки)';
