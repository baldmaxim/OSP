-- Реестр контрагентов (/general/counterparties): постоянный номер и отметка «есть регистрация на сайте»
-- (решение пользователя 05.11.2026).
--
-- 1. counterparties.counterparty_number. Раньше «№» был номером строки в текущей выборке и менялся при каждом фильтре.
--    Теперь номер закреплён за контрагентом: новому — следующий (GENERATED ALWAYS: задать или поменять запросом нельзя),
--    удалённый свой номер сохраняет, номера не переиспользуются.
--    Прежним — как стоял «№» во вкладке «Активные»: действующие по названию, затем чёрный список, затем удалённые.
--    Присвоение номера — не правка контрагента: отметка updated_at не меняется, поэтому на время присвоения триггеры
--    таблицы выключены (та же транзакция, таблица занята).
-- 2. counterparty_site_accounts() — у каких организаций есть действующая учётка кабинета подрядчика и сколько их.
--    Сотруднику строки user_roles закрыты (там почта и ФИО), поэтому отдельная функция: только id организации и число;
--    результат — только тем, кто видит раздел «Контрагенты». Заблокированные и неодобренные учётки не считаются.
--
-- Правила по строкам не меняются. Повтор безопасен: выданные номера не трогаются. Пока миграции нет, страница считает
-- номер сама тем же порядком, а фильтра «С регистрацией» нет.
-- База нового портала (Яндекс) — migration/yandex/20261225_counterparty_number.sql.
-- Проверка: migration/backup/checks/20261225.sql, откат: migration/rollback/20261225_counterparty_number_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.counterparties ADD COLUMN IF NOT EXISTS counterparty_number integer;

-- Номера и счётчик — только при первом применении: у колонки со счётчиком (GENERATED ALWAYS) даже UPDATE без строк
-- запрещён, а повтор не должен ни перенумеровать, ни отмотать счётчик назад.
DO $$
DECLARE
  v_triggers text[];
  v_trigger text;
  -- Порядок страницы — Intl.Collator('ru'), это тот же ICU. Без него (сборка без ICU) — порядок базы.
  v_collate text := CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_collation WHERE collname = 'ru-x-icu')
                         THEN 'COLLATE "ru-x-icu"' ELSE '' END;
BEGIN
  IF (SELECT attidentity FROM pg_attribute
      WHERE attrelid = 'public.counterparties'::regclass AND attname = 'counterparty_number') = '' THEN
    SELECT coalesce(array_agg(tgname::text), '{}') INTO v_triggers FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.counterparties'::regclass AND NOT tgisinternal AND tgenabled = 'O';
    FOREACH v_trigger IN ARRAY v_triggers LOOP
      EXECUTE format('ALTER TABLE public.counterparties DISABLE TRIGGER %I', v_trigger);
    END LOOP;

    EXECUTE format($q$
      WITH numbered AS (
        SELECT id,
               (SELECT coalesce(max(counterparty_number), 0) FROM public.counterparties)
                 + row_number() OVER (ORDER BY (deleted_at IS NOT NULL), (status::text = 'blacklist') IS TRUE, name %s, id) AS rn
        FROM public.counterparties
        WHERE counterparty_number IS NULL
      )
      UPDATE public.counterparties c SET counterparty_number = n.rn
      FROM numbered n
      WHERE c.id = n.id$q$, v_collate);

    FOREACH v_trigger IN ARRAY v_triggers LOOP
      EXECUTE format('ALTER TABLE public.counterparties ENABLE TRIGGER %I', v_trigger);
    END LOOP;

    ALTER TABLE public.counterparties ALTER COLUMN counterparty_number SET NOT NULL;
    ALTER TABLE public.counterparties ALTER COLUMN counterparty_number ADD GENERATED ALWAYS AS IDENTITY;
    PERFORM setval(pg_get_serial_sequence('public.counterparties', 'counterparty_number'),
                   coalesce((SELECT max(counterparty_number) FROM public.counterparties), 0) + 1, false);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS counterparties_number_key ON public.counterparties (counterparty_number);

COMMENT ON COLUMN public.counterparties.counterparty_number IS
  'Постоянный номер контрагента («№» в реестре): присваивается при создании, не меняется и не переиспользуется';

CREATE OR REPLACE FUNCTION public.counterparty_site_accounts()
  RETURNS TABLE (counterparty_id uuid, accounts integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT ur.counterparty_id, count(*)::integer
  FROM public.user_roles ur
  WHERE (SELECT public.osp_can('counterparties', 'view'))
    AND ur.counterparty_id IS NOT NULL
    AND ur.role = 'contractor'
    AND ur.is_approved
    AND NOT ur.is_blocked
  GROUP BY ur.counterparty_id
$$;
COMMENT ON FUNCTION public.counterparty_site_accounts() IS
  'Реестр контрагентов: организации с действующей учёткой кабинета подрядчика и число учёток. Только раздел «Контрагенты»; ни почты, ни ФИО.';
REVOKE ALL ON FUNCTION public.counterparty_site_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.counterparty_site_accounts() TO authenticated, service_role;

COMMIT;
