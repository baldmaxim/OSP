-- «Заявки на ДС»: суммы — одним блоком из двух частей (решение пользователя 06.11.2026, образец — картинка).
--   Верхняя часть: «Было ПСДЦ» (amount_before), «ДС подрядчика» (amount_contractor — новая), «Согласовано ДС ОСП»
--   (amount_after). Нижняя часть: «Было ВОР подрядчик» (vor_amount_before — новая), «Стало ВОР ОСП»
--   (vor_amount_after — новая). Обе части у каждой заявки; тип ДС суммы между частями не переносит.
-- Разовый перенос (только при добавлении колонок): у заявок «ДС по тендеру» прежние «Было подано» / «Утверждено» —
-- суммы ВОР, они переезжают в нижнюю часть; верхняя у них становится пустой. На каждую такую заявку — запись в её
-- истории. Правила по строкам не меняются — колонки той же таблицы. Повтор безопасен: перенос не повторяется.
-- База нового портала (Яндекс) — migration/yandex/20270104_dc_request_amounts_vor.sql (то же тело).
-- Проверка: migration/backup/checks/20270104.sql; откат — migration/rollback/20270104_dc_request_amounts_vor_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.dc_requests ADD COLUMN IF NOT EXISTS amount_contractor numeric(14, 2);
COMMENT ON COLUMN public.dc_requests.amount_contractor IS 'ДС подрядчика, руб. с НДС 22%';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'dc_requests' AND column_name = 'vor_amount_before') THEN
    ALTER TABLE public.dc_requests
      ADD COLUMN vor_amount_before numeric(14, 2),
      ADD COLUMN vor_amount_after numeric(14, 2);

    WITH moved AS (
      UPDATE public.dc_requests
      SET vor_amount_before = amount_before, vor_amount_after = amount_after,
          amount_before = NULL, amount_after = NULL
      WHERE ds_type = 'tender_ds' AND (amount_before IS NOT NULL OR amount_after IS NOT NULL)
      RETURNING id, vor_amount_before, vor_amount_after
    )
    INSERT INTO public.dc_request_audit_log
      (dc_request_id, event_type, field_name, old_value, new_value, description, changed_by_name)
    SELECT id, 'field_updated', 'vor_amount_before',
           jsonb_build_object('amount_before', vor_amount_before, 'amount_after', vor_amount_after),
           jsonb_build_object('vor_amount_before', vor_amount_before, 'vor_amount_after', vor_amount_after),
           'ДС по тендеру: суммы перенесены в «Было ВОР подрядчик» / «Стало ВОР ОСП» (миграция 20270104)',
           'Перенос данных'
    FROM moved;
  END IF;
END $$;

COMMENT ON COLUMN public.dc_requests.vor_amount_before IS 'Было ВОР подрядчик, руб. с НДС 22%';
COMMENT ON COLUMN public.dc_requests.vor_amount_after IS 'Стало ВОР ОСП, руб. с НДС 22%';

COMMIT;
