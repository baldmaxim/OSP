-- НДС контрагента — вкладка «Общая информация» карточки контрагента (/general/counterparties):
-- ставка в процентах (vat_rate) либо «без НДС» (vat_exempt: УСН, освобождение); ни того ни другого —
-- «не указан». Одновременно ставка и «без НДС» быть не могут.
--
-- Правила по строкам и права не меняются — это колонки той же таблицы counterparties. Данные не
-- меняются: НДС ни у кого не указан. Повтор безопасен. Пока миграции нет, вкладка показывает НДС
-- подписью «появится после обновления базы».
-- База нового портала (Яндекс) — migration/yandex/20261026_counterparty_vat.sql.
-- Проверка: migration/backup/checks/20261026.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.counterparties
  ADD COLUMN IF NOT EXISTS vat_rate numeric(5,2),
  ADD COLUMN IF NOT EXISTS vat_exempt boolean NOT NULL DEFAULT false;
ALTER TABLE public.counterparties DROP CONSTRAINT IF EXISTS counterparties_vat_check;
ALTER TABLE public.counterparties ADD CONSTRAINT counterparties_vat_check
  CHECK ((vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 100)) AND NOT (vat_exempt AND vat_rate IS NOT NULL));
COMMENT ON COLUMN public.counterparties.vat_rate IS 'Ставка НДС контрагента, % (0/5/7/10/20/22); NULL — не указана или «без НДС»';
COMMENT ON COLUMN public.counterparties.vat_exempt IS 'Контрагент работает без НДС (УСН, освобождение)';

COMMIT;
