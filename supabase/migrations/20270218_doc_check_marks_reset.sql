-- «Заявки на проверку ДП/ДС»: цветов и приоритетов у карточек больше нет (решение пользователя 18.11.2026). Сброс у всех
-- заявок, вместе с удалёнными и архивом; колонки priority и color остаются (их читает прежняя страница до выкладки).
-- Подробно — в базе нового портала: migration/yandex/20270218_doc_check_marks_reset.sql. Тело то же; прежние значения — в
-- osp_private.doc_check_marks_backup_20270218: закрытая схема, PostgREST её не отдаёт, anon и authenticated прав на неё нет.
-- updated_at не меняется: триггер выключен только на этот UPDATE. Повтор безопасен.
-- Проверка: migration/backup/checks/20270218.sql, откат — migration/rollback/20270218_doc_check_marks_reset_rollback.sql.
-- Применять в нерабочее время: ALTER TABLE ненадолго блокирует таблицу заявок.

BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE SCHEMA IF NOT EXISTS osp_private;
REVOKE ALL ON SCHEMA osp_private FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS osp_private.doc_check_marks_backup_20270218 (
  request_id uuid PRIMARY KEY,
  priority text,
  color text,
  saved_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE osp_private.doc_check_marks_backup_20270218 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON osp_private.doc_check_marks_backup_20270218 FROM PUBLIC, anon, authenticated;
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

COMMIT;
