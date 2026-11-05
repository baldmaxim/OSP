-- «Договоры и ДС»: отметка «Загружено в Estimat» у договора и ДС — плашка рядом с номером, три состояния по кругу,
-- как «ТГ» у тендеров ОС (решение пользователя 03.11.2026):
-- не загружено (серая) → загружено (зелёная) → не загружать (красная) → не загружено (src/utils/contractEstimat.js).
--
--  • estimat_status — none | uploaded | skip; у всех документов сейчас none, данные не меняются.
--  • estimat_status_at / estimat_status_by — кто и когда выставил (ФИО слепком), как у отметки «ТГ»; у none пусто.
--  • Завершённый документ менять отметку не мешает: колонки нет в списке contracts_hierarchy_guard — это не условие договора.
--
-- Права не меняются: колонки той же таблицы contracts. Подрядчику они не отдаются: contractor_contracts — перечень полей.
-- Только добавление, повтор безопасен. Пока миграции нет, плашки в реестре нет.
-- База нового портала (Яндекс) — migration/yandex/20261211_contracts_estimat_status.sql.
-- Проверка: migration/backup/checks/20261211.sql; откат — migration/rollback/20261211_contracts_estimat_status_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS estimat_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS estimat_status_at timestamptz,
  ADD COLUMN IF NOT EXISTS estimat_status_by text;

ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_estimat_status_check;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_estimat_status_check
  CHECK (estimat_status IN ('none', 'uploaded', 'skip'));

COMMENT ON COLUMN public.contracts.estimat_status IS 'Загрузка документа в Estimat: none — не загружен, uploaded — загружен, skip — не загружать';
COMMENT ON COLUMN public.contracts.estimat_status_at IS 'Когда выставлена отметка Estimat';
COMMENT ON COLUMN public.contracts.estimat_status_by IS 'Кто выставил отметку Estimat (ФИО/e-mail)';

COMMIT;
