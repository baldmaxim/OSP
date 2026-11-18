-- «Заявки на проверку ДП/ДС»: цветов и приоритетов у карточек больше нет (решение пользователя 18.11.2026: «убери цвета и
-- приоритеты полностью. Сбрось все существующие цвета и приоритеты у карточек»). Страница их больше не показывает, не
-- фильтрует и не пишет; здесь — сброс у всех заявок, вместе с удалёнными и архивом. Тело то же, что
-- supabase/migrations/20270218_doc_check_marks_reset.sql (прежние значения в обеих базах — в закрытой схеме osp_private).
--
-- Колонки priority и color и их ограничения остаются: их по имени читает прежняя страница (до выкладки сайта). Без колонок
-- она откатилась бы на набор полей без исполнителей, сроков и меток. Убрать колонки — отдельной миграцией, когда прежних
-- вкладок не останется.
-- Прежние значения — в osp_private.doc_check_marks_backup_20270218 (откат возвращает их; пишется один раз на заявку).
-- updated_at не меняется (по нему уведомления считают заявку свежей): триггер выключен только на этот UPDATE. История заявки
-- (вкладка «История») не пишется: её триггер (20270216) молчит без вошедшего, а страница поля больше не показывает.
-- Повтор безопасен: отметок нет — данные не меняются. База без колонок доски (20261113) — ничего не делает.
-- Проверка — 20270218_doc_check_marks_reset.check.sql, для прода — migration/backup/checks/20270218.sql; откат —
-- migration/rollback/20270218_doc_check_marks_reset_rollback.sql.
CREATE TABLE IF NOT EXISTS osp_private.doc_check_marks_backup_20270218 (
  request_id uuid PRIMARY KEY,
  priority text,
  color text,
  saved_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE osp_private.doc_check_marks_backup_20270218 ENABLE ROW LEVEL SECURITY;
ALTER TABLE osp_private.doc_check_marks_backup_20270218 FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osp_internal ON osp_private.doc_check_marks_backup_20270218;
CREATE POLICY osp_internal ON osp_private.doc_check_marks_backup_20270218 FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
COMMENT ON TABLE osp_private.doc_check_marks_backup_20270218 IS
  'Цвет и приоритет заявок на проверку ДП/ДС до сброса миграцией 20270218 (для отката)';

DO $$
DECLARE
  v_touch boolean := EXISTS (SELECT 1 FROM pg_trigger
                             WHERE tgrelid = 'public.doc_check_requests'::regclass
                               AND tgname = 'trg_doc_check_requests_updated_at' AND NOT tgisinternal);
  v_marked boolean;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'doc_check_requests' AND column_name IN ('priority', 'color')) < 2 THEN
    RETURN;
  END IF;
  -- Колонки читаются строками запроса: в базе без них блок не должен разбираться.
  EXECUTE $c$COMMENT ON COLUMN public.doc_check_requests.priority IS
    'Не используется с 18.11.2026 (миграция 20270218: сброшен у всех заявок, страница не показывает и не пишет)'$c$;
  EXECUTE $c$COMMENT ON COLUMN public.doc_check_requests.color IS
    'Не используется с 18.11.2026 (миграция 20270218: сброшен у всех заявок, страница не показывает и не пишет)'$c$;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.doc_check_requests WHERE priority IS NOT NULL OR color IS NOT NULL)' INTO v_marked;
  IF NOT v_marked THEN
    RETURN;
  END IF;

  EXECUTE 'INSERT INTO osp_private.doc_check_marks_backup_20270218 (request_id, priority, color)
           SELECT id, priority, color FROM public.doc_check_requests WHERE priority IS NOT NULL OR color IS NOT NULL
           ON CONFLICT (request_id) DO NOTHING';

  IF v_touch THEN
    ALTER TABLE public.doc_check_requests DISABLE TRIGGER trg_doc_check_requests_updated_at;
  END IF;
  EXECUTE 'UPDATE public.doc_check_requests SET priority = NULL, color = NULL WHERE priority IS NOT NULL OR color IS NOT NULL';
  IF v_touch THEN
    ALTER TABLE public.doc_check_requests ENABLE TRIGGER trg_doc_check_requests_updated_at;
  END IF;
END
$$;
