-- Убирает прежнюю таблицу договорных расценок Larix public.larix_contract_rates (строка × вид, миграция 20261018).
-- С 20261021 загрузка пишет osp_private.larix_rates, вкладка и /api/rates/larix читают её через larix_rates_registry;
-- 20261021 оставила старую таблицу для вкладок, открытых до той выкладки, и обещала убрать её отдельной миграцией.
-- Место: 153 МБ (замер 03.11.2026).
--
-- Отката нет и он не нужен: строки — устаревший снимок той же выгрузки, сайт их не читает, источник — Larix.CPM.
-- Предохранитель: в старой таблице есть строки, а новая пуста — отказ, ничего не меняется.
-- DROP без CASCADE: если на таблицу что-то опирается (представление, внешний ключ), миграция упадёт и откатится целиком.
-- Только база нового портала: у прежнего портала (Supabase) своя такая таблица, её не трогаем.
-- Повтор безопасен. Проверка — 20261221_drop_larix_contract_rates.check.sql.
-- Порядок на сервере: migrate, затем backend (список шлюза лежит в образе API).

DO $$
BEGIN
  IF to_regclass('public.larix_contract_rates') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.larix_contract_rates) AND NOT EXISTS (SELECT 1 FROM osp_private.larix_rates) THEN
      RAISE EXCEPTION 'osp_private.larix_rates пуста, а в public.larix_contract_rates есть строки: таблица не удаляется';
    END IF;
  END IF;
END $$;

DELETE FROM osp_meta.policy_roles WHERE schema_name = 'public' AND table_name = 'larix_contract_rates';
DROP TABLE IF EXISTS public.larix_contract_rates;
-- osp:allow table larix_contract_rates none
