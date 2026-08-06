-- Отметка о публикации тендера в Telegram-канале. После запуска тендера сотрудник
-- публикует его в ТГ-канале и отмечает это здесь (галочка в строке тендера).
ALTER TABLE tenders
  ADD COLUMN IF NOT EXISTS tg_published BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tg_published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tg_published_by TEXT;

COMMENT ON COLUMN tenders.tg_published IS 'Тендер опубликован в Telegram-канале';
COMMENT ON COLUMN tenders.tg_published_at IS 'Когда отмечена публикация в ТГ';
COMMENT ON COLUMN tenders.tg_published_by IS 'Кто отметил публикацию в ТГ (ФИО/e-mail)';
