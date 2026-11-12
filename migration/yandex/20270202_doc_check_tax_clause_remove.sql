-- «Заявки на проверку ДП/ДС»: колонки «Проверка документов (исключение налоговой оговорки)» больше нет ни на доске, ни в базе
-- (решение пользователя 10.11.2026, повторено 12.11: «задачи перенеси в завершённые и полностью удали … убедись, что нет
-- задач-дубликатов»). Тело — supabase/migrations/20270202_doc_check_tax_clause_remove.sql.
--
-- Что было (чтение базы Яндекса 12.11.2026): в статусе tax_clause 106 живых заявок (32 ДП, 74 ДС). Все созданы одной массовой
-- копией на прежней доске 07.04.2026 в 07:16, и у каждой ровно один оригинал, и он в «Завершено»: тот же вид документа,
-- объект, контрагент, номер и текст карточки до «Исполнители» (у 101 примечание совпадает слово в слово). Файлов у копий нет;
-- 5 сообщений есть у одной копии, и те же 5 — у её оригинала. Перенести копии в «Завершено» значило бы задвоить там 106
-- заявок, поэтому:
--  • копия (есть оригинал: не удалённая заявка в другой колонке с тем же видом, объектом, контрагентом, номером и текстом
--    карточки) — в «Удалённые», статус «Завершено», в историю — «Удалена как дубль заявки ID N». Вернуть — на странице;
--  • заявка без оригинала (на 12.11 таких нет) — в «Завершено», вниз колонки, в прежнем порядке; в историю — смена статуса;
--  • уже удалённая заявка в этом статусе (на 12.11 таких нет) — только статус «Завершено».
-- Затем tax_clause убирается из списка статусов: заявка в нём больше не появится, колонке на доске взяться неоткуда.
-- Другие заявки, похожие друг на друга (одинаковые контрагент и номер ДС), не трогаются: они поданы в разные дни и часто к
-- разным договорам — это повторные заявки, а не копии.
-- updated_at не меняется (по нему уведомления считают заявку свежей): триггер выключен только на эти UPDATE.
-- Повтор безопасен: заявок в статусе нет — данные не меняются. Проверка — 20270202_doc_check_tax_clause_remove.check.sql,
-- для прода — migration/backup/checks/20270202.sql; откат — migration/rollback/20270202_doc_check_tax_clause_remove_rollback.sql.
DO $$
DECLARE
  c_who constant text := 'Исправление данных 12.11.2026 (миграция 20270202)';
  c_column constant text := '«Проверка документов (исключение налоговой оговорки)»';
  v_touch boolean := EXISTS (SELECT 1 FROM pg_trigger
                             WHERE tgrelid = 'public.doc_check_requests'::regclass
                               AND tgname = 'trg_doc_check_requests_updated_at' AND NOT tgisinternal);
  v_now timestamptz := now();
  v_bottom integer;
  v_place text;
  r record;
  o record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.doc_check_requests WHERE status = 'tax_clause') THEN
    RETURN;
  END IF;
  IF v_touch THEN
    ALTER TABLE public.doc_check_requests DISABLE TRIGGER trg_doc_check_requests_updated_at;
  END IF;

  -- Низ колонки «Завершено»: новые сверху, больший sort_order выше.
  SELECT coalesce(min(sort_order), 0) INTO v_bottom
  FROM public.doc_check_requests WHERE status = 'done' AND deleted_at IS NULL;

  -- Текст карточки — примечание до «Исполнители», только буквы и цифры (без классов символов: они зависят от локали базы).
  FOR r IN
    SELECT t.*,
           regexp_replace(split_part(coalesce(t.notes, ''), 'Исполнители', 1), '[^0-9A-Za-zА-Яа-яЁё]', '', 'g') AS card_text,
           regexp_replace(coalesce(t.doc_number, ''), '[^0-9A-Za-zА-Яа-яЁё/._-]', '', 'g') AS number_key
    FROM public.doc_check_requests t
    WHERE t.status = 'tax_clause'
    ORDER BY t.sort_order DESC, t.created_at, t.id
  LOOP
    IF r.deleted_at IS NOT NULL THEN
      UPDATE public.doc_check_requests SET status = 'done' WHERE id = r.id;
      INSERT INTO public.doc_check_request_audit_log (request_id, event_type, field_name, old_value, new_value, description, changed_by_name)
      VALUES (r.id, 'status_changed', 'status', to_jsonb('tax_clause'::text), to_jsonb('done'::text),
              'Колонка ' || c_column || ' убрана с доски', c_who);
      CONTINUE;
    END IF;

    SELECT x.id, to_jsonb(x) ->> 'request_number' AS num, x.status, to_jsonb(x) ->> 'archived_at' AS archived_at, x.created_at
      INTO o
    FROM public.doc_check_requests x
    WHERE x.id <> r.id AND x.status <> 'tax_clause' AND x.deleted_at IS NULL
      AND x.doc_type = r.doc_type
      AND x.object_id IS NOT DISTINCT FROM r.object_id
      AND x.counterparty_id IS NOT DISTINCT FROM r.counterparty_id
      AND regexp_replace(coalesce(x.doc_number, ''), '[^0-9A-Za-zА-Яа-яЁё/._-]', '', 'g') = r.number_key
      AND r.card_text <> ''
      AND regexp_replace(split_part(coalesce(x.notes, ''), 'Исполнители', 1), '[^0-9A-Za-zА-Яа-яЁё]', '', 'g') = r.card_text
    ORDER BY (coalesce(x.notes, '') = coalesce(r.notes, '')) DESC, x.created_at, x.id
    LIMIT 1;

    IF FOUND THEN
      v_place := CASE WHEN o.archived_at IS NOT NULL THEN 'в архиве'
                      ELSE 'в колонке «' || CASE o.status
                        WHEN 'new' THEN 'Новые заявки' WHEN 'in_progress' THEN 'В работе' WHEN 'edo' THEN 'Выгрузка по ЭДО'
                        WHEN 'signal' THEN 'Загрузка в Signal' WHEN 'accounting' THEN 'Загрузка в 1С' WHEN 'done' THEN 'Завершено'
                        WHEN 'awaiting_scan' THEN 'Ожидаем скан ДП/ДС' ELSE o.status END || '»' END;
      UPDATE public.doc_check_requests SET status = 'done', deleted_at = v_now WHERE id = r.id;
      INSERT INTO public.doc_check_request_audit_log (request_id, event_type, description, changed_by_name)
      VALUES (r.id, 'soft_deleted',
              'Удалена как дубль заявки ' || coalesce('ID ' || o.num, 'от ' || to_char(o.created_at, 'DD.MM.YYYY')) || ' (она ' || v_place
                || '): копия стояла в колонке ' || c_column || ', колонку убрали с доски',
              c_who);
    ELSE
      v_bottom := v_bottom - 1;
      UPDATE public.doc_check_requests SET status = 'done', sort_order = v_bottom WHERE id = r.id;
      INSERT INTO public.doc_check_request_audit_log (request_id, event_type, field_name, old_value, new_value, description, changed_by_name)
      VALUES (r.id, 'status_changed', 'status', to_jsonb('tax_clause'::text), to_jsonb('done'::text),
              'Колонка ' || c_column || ' убрана с доски — заявка перенесена в «Завершено»', c_who);
    END IF;
  END LOOP;

  IF v_touch THEN
    ALTER TABLE public.doc_check_requests ENABLE TRIGGER trg_doc_check_requests_updated_at;
  END IF;
END
$$;

ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_status_check;
ALTER TABLE public.doc_check_requests ADD CONSTRAINT doc_check_requests_status_check
  CHECK (status IN ('new', 'in_progress', 'edo', 'signal', 'accounting', 'done', 'awaiting_scan'));

COMMENT ON COLUMN public.doc_check_requests.status IS
  'new | in_progress | edo (выгрузка по ЭДО) | signal (загрузка в Signal) | accounting (загрузка в 1С) | done | awaiting_scan (ждём подписанный бумажный оригинал)';
