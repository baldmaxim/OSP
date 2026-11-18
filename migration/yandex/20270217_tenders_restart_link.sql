-- «Тендеры»: каким тендером перезапущен тендер в статусе «Перезапуск» (решение пользователя 18.11.2026: при выборе статуса
-- «Перезапуск» в «Тендерах — Основное строительство» можно указать новый тендер, который его заменяет; у нового рядом с номером
-- мельче — «перезапуск № N» со ссылкой на прежний). Тело — supabase/migrations/20270217_tenders_restart_link.sql.
--
-- Колонка — у прежнего тендера: один новый может заменить несколько прежних (733 ← 73 и 81), у прежнего — один заменивший.
-- Ссылка необязательна (новый тендер заводят и позже); пишет страница вместе со статусом и снимает, когда статус уходит из
-- «Перезапуска». Удалили новый тендер безвозвратно — ссылка пустеет (ON DELETE SET NULL), прежний остаётся «Перезапуском».
-- Правила строк tenders и список шлюза не меняются (колонка той же таблицы). Данные не меняются: колонка у всех пустая.
-- Повтор безопасен. Проверка — 20270217_tenders_restart_link.check.sql, для прода — migration/backup/checks/20270217.sql;
-- откат — migration/rollback/20270217_tenders_restart_link_rollback.sql.
ALTER TABLE public.tenders ADD COLUMN IF NOT EXISTS restarted_by_tender_id uuid;

ALTER TABLE public.tenders DROP CONSTRAINT IF EXISTS tenders_restarted_by_tender_id_fkey;
ALTER TABLE public.tenders ADD CONSTRAINT tenders_restarted_by_tender_id_fkey
  FOREIGN KEY (restarted_by_tender_id) REFERENCES public.tenders(id) ON DELETE SET NULL;

ALTER TABLE public.tenders DROP CONSTRAINT IF EXISTS tenders_restarted_by_not_self;
ALTER TABLE public.tenders ADD CONSTRAINT tenders_restarted_by_not_self
  CHECK (restarted_by_tender_id IS NULL OR restarted_by_tender_id <> id);

-- Чем перезапущен этот тендер (карточка нового) и ON DELETE SET NULL — по индексу.
CREATE INDEX IF NOT EXISTS idx_tenders_restarted_by_tender_id ON public.tenders (restarted_by_tender_id)
  WHERE restarted_by_tender_id IS NOT NULL;

COMMENT ON COLUMN public.tenders.restarted_by_tender_id IS
  'Тендер, которым перезапущен этот (статус «Перезапуск»); NULL — не указан. Действует, пока статус — «Перезапуск»';
