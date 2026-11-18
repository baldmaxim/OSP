-- «Тендеры»: каким тендером перезапущен тендер в статусе «Перезапуск» (решение пользователя 18.11.2026). Колонка у прежнего
-- тендера, ссылка необязательна, пишет страница вместе со статусом. Подробно — в базе нового портала:
-- migration/yandex/20270217_tenders_restart_link.sql. Тело то же. Данные не меняются.
-- Проверка: migration/backup/checks/20270217.sql, откат — migration/rollback/20270217_tenders_restart_link_rollback.sql.
-- Применять в нерабочее время: ALTER TABLE ненадолго блокирует таблицу тендеров.

BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.tenders ADD COLUMN IF NOT EXISTS restarted_by_tender_id uuid;

ALTER TABLE public.tenders DROP CONSTRAINT IF EXISTS tenders_restarted_by_tender_id_fkey;
ALTER TABLE public.tenders ADD CONSTRAINT tenders_restarted_by_tender_id_fkey
  FOREIGN KEY (restarted_by_tender_id) REFERENCES public.tenders(id) ON DELETE SET NULL;

ALTER TABLE public.tenders DROP CONSTRAINT IF EXISTS tenders_restarted_by_not_self;
ALTER TABLE public.tenders ADD CONSTRAINT tenders_restarted_by_not_self
  CHECK (restarted_by_tender_id IS NULL OR restarted_by_tender_id <> id);

CREATE INDEX IF NOT EXISTS idx_tenders_restarted_by_tender_id ON public.tenders (restarted_by_tender_id)
  WHERE restarted_by_tender_id IS NOT NULL;

COMMENT ON COLUMN public.tenders.restarted_by_tender_id IS
  'Тендер, которым перезапущен этот (статус «Перезапуск»); NULL — не указан. Действует, пока статус — «Перезапуск»';

-- PostgREST перечитывает связи: встраивания tenders!parent_tender_id и т. п. остаются однозначными (с подсказкой колонки).
NOTIFY pgrst, 'reload schema';

COMMIT;
