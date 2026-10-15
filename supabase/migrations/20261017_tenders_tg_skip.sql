-- Третье состояние отметки «ТГ» в реестре тендеров — «Не публиковать» (красная плашка).
-- Клик по кругу: не опубликовано → опубликовано → не публиковать → не опубликовано
-- (src/utils/tgPublish.js). Опубликовано и «не публиковать» одновременно быть не может.
-- Права и правила строк не меняются — это колонки той же таблицы tenders. Данные не меняются:
-- у всех тендеров tg_skip = false. Пока миграции нет, интерфейс оставляет два состояния.
-- База нового портала (Яндекс) — migration/yandex/20261017_tenders_tg_skip.sql.
-- Проверка: migration/backup/checks/20261017.sql.
ALTER TABLE public.tenders
  ADD COLUMN IF NOT EXISTS tg_skip BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tg_skip_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tg_skip_by TEXT;

ALTER TABLE public.tenders DROP CONSTRAINT IF EXISTS tenders_tg_state_check;
ALTER TABLE public.tenders
  ADD CONSTRAINT tenders_tg_state_check CHECK (NOT (tg_published AND tg_skip));

COMMENT ON COLUMN public.tenders.tg_skip IS 'Тендер не публикуется в Telegram-канале (решение сотрудника)';
COMMENT ON COLUMN public.tenders.tg_skip_at IS 'Когда отмечено «не публиковать в ТГ»';
COMMENT ON COLUMN public.tenders.tg_skip_by IS 'Кто отметил «не публиковать в ТГ» (ФИО/e-mail)';
