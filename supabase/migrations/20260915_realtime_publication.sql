-- Онлайн-обновления (Supabase Realtime) для совместной работы.
--
-- Зачем: по тендерам одновременно работают несколько инженеров, и правку коллеги
-- было видно только после F5. То же в протоколе разногласий: подрядчик и юрист
-- обсуждают пункт и не видят реплик друг друга без перезагрузки.
--
-- Realtime отдаёт изменения только тех таблиц, которые состоят в публикации
-- supabase_realtime. Права при этом не обходятся: события фильтруются теми же
-- RLS-политиками, под токеном подписчика. Поэтому подрядчик получит события
-- только по своим договорам, а сотрудник — по всему, что ему и так доступно.
--
-- REPLICA IDENTITY FULL нужна, чтобы в событии приходила полная старая строка:
-- без неё Realtime не может применить RLS к UPDATE/DELETE и молча их не покажет.
-- Таблицы небольшие, рост WAL некритичен.
--
-- Миграция идемпотентна.

DO $$
DECLARE
  t text;
BEGIN
  -- Публикация создаётся самим Supabase; на всякий случай проверяем.
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'tenders',                      -- статусы, сроки, ответственные
    'tender_counterparties',        -- участники и их статусы («КП предоставлено»)
    'contract_clauses',             -- пункты договора (итоговая редакция)
    'contract_clause_disputes',     -- разногласия по пунктам
    'contract_clause_comments'      -- переписка по пункту
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;

    EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
