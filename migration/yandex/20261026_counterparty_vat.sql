-- НДС контрагента — вкладка «Общая информация» карточки контрагента. Тело supabase/migrations/20261026_counterparty_vat.sql:
-- колонки той же таблицы counterparties и ограничение — правила по строкам и список шлюза не меняются. Данные не
-- меняются: НДС ни у кого не указан. Повтор безопасен.
--
--  • vat_rate — ставка, % (0/5/7/10/20/22); vat_exempt — «без НДС» (УСН, освобождение); одновременно нельзя.
ALTER TABLE public.counterparties
  ADD COLUMN IF NOT EXISTS vat_rate numeric(5,2),
  ADD COLUMN IF NOT EXISTS vat_exempt boolean NOT NULL DEFAULT false;
ALTER TABLE public.counterparties DROP CONSTRAINT IF EXISTS counterparties_vat_check;
ALTER TABLE public.counterparties ADD CONSTRAINT counterparties_vat_check
  CHECK ((vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 100)) AND NOT (vat_exempt AND vat_rate IS NOT NULL));
COMMENT ON COLUMN public.counterparties.vat_rate IS 'Ставка НДС контрагента, % (0/5/7/10/20/22); NULL — не указана или «без НДС»';
COMMENT ON COLUMN public.counterparties.vat_exempt IS 'Контрагент работает без НДС (УСН, освобождение)';
