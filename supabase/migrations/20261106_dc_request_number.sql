-- Постоянный номер заявки на ДС — колонка «№» в /dc-requests. Раньше «№» был номером строки в текущей выборке и
-- менялся при переключении вкладок и фильтров; теперь номер присваивается заявке при создании и не меняется
-- (удалённая заявка свой номер сохраняет, номера не переиспользуются).
--
-- Прежним заявкам — по порядку создания, как стоял «№» во вкладке «Все» у сотрудника без ограничения по объектам:
-- сначала не удалённые, затем удалённые. Новым — следующий номер (GENERATED ALWAYS: задать или поменять номер
-- запросом нельзя). Правила по строкам и права не меняются — это колонка той же таблицы. Повтор безопасен:
-- уже выданные номера не трогаются, счётчик ставится после наибольшего. Пока миграции нет, страница считает номер
-- сама по порядку создания.
-- База нового портала (Яндекс) — migration/yandex/20261106_dc_request_number.sql.
-- Проверка: migration/backup/checks/20261106.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.dc_requests ADD COLUMN IF NOT EXISTS request_number integer;

-- Номера и счётчик — только при первом применении: у колонки со счётчиком (GENERATED ALWAYS) даже UPDATE без строк
-- запрещён, а повтор не должен ни перенумеровать, ни отмотать счётчик назад.
DO $$
BEGIN
  IF (SELECT attidentity FROM pg_attribute
      WHERE attrelid = 'public.dc_requests'::regclass AND attname = 'request_number') = '' THEN
    WITH numbered AS (
      SELECT id,
             (SELECT coalesce(max(request_number), 0) FROM public.dc_requests)
               + row_number() OVER (ORDER BY (deleted_at IS NOT NULL), created_at, id) AS rn
      FROM public.dc_requests
      WHERE request_number IS NULL
    )
    UPDATE public.dc_requests r SET request_number = n.rn
    FROM numbered n
    WHERE r.id = n.id;

    ALTER TABLE public.dc_requests ALTER COLUMN request_number SET NOT NULL;
    ALTER TABLE public.dc_requests ALTER COLUMN request_number ADD GENERATED ALWAYS AS IDENTITY;
    PERFORM setval(pg_get_serial_sequence('public.dc_requests', 'request_number'),
                   coalesce((SELECT max(request_number) FROM public.dc_requests), 0) + 1, false);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS dc_requests_request_number_key ON public.dc_requests (request_number);

COMMENT ON COLUMN public.dc_requests.request_number IS
  'Постоянный номер заявки на ДС («№» в реестре): присваивается при создании, не меняется и не переиспользуется';

COMMIT;
