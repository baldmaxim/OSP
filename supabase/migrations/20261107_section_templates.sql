-- Шаблоны разделов — файлы, которые раздел даёт скачать всем: «Понятийное соглашение» в «Документах раздела»
-- тендеров (вкладка «Материалы») и «Шаблон Было-Стало» в «Документах» заявок на ДС.
--
--  • section_templates — строка = шаблон: постоянный код (его знает код страницы) и название. Строки заводит
--    эта миграция, из портала таблица не пишется — это якорь для файла, не список.
--  • Файл шаблона — s3_documents (owner_type 'general', owner_id = section_templates.id,
--    doc_category 'section_template'): как ПСДЦ и заявки на ВОР, отдельная папка бакета и передеплой
--    функции s3-presign не нужны. Новый файл заменяет прежний (сначала загружается новый, затем удаляется
--    старый). На сервере (osp-api) прикрепить и удалить файл может только администратор
--    (WRITE_RULES.section_templates), в интерфейсе — так же.
--  • Права: строки читает сотрудник (osp_is_employee), писать некому; гостю и подрядчику — ничего.
-- База нового портала (Яндекс) — migration/yandex/20261107_section_templates.sql.
-- Проверка: migration/backup/checks/20261107.sql; откат — migration/rollback/20261107_section_templates_rollback.sql.
-- Только добавление, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.section_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]{1,64}$'),
  title text NOT NULL CHECK (title <> '' AND length(title) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.section_templates IS
  'Шаблоны разделов: якорь для файла (s3_documents owner_type general, doc_category section_template); строки заводят миграции';
COMMENT ON COLUMN public.section_templates.code IS
  'Постоянный код шаблона в коде страницы: tenders_concept_agreement, dc_was_became';

-- ── Права ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.section_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS section_templates_read ON public.section_templates;
CREATE POLICY section_templates_read ON public.section_templates FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));

-- Новые таблицы Supabase по умолчанию выдаёт анониму — снимаем всё явно; вошедшему — только чтение.
REVOKE ALL ON TABLE public.section_templates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.section_templates TO authenticated;
GRANT ALL ON TABLE public.section_templates TO service_role;

-- ── Шаблоны ──────────────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.section_templates (code, title) VALUES
  ('tenders_concept_agreement', 'Понятийное соглашение'),
  ('dc_was_became', 'Шаблон Было-Стало')
ON CONFLICT (code) DO NOTHING;

COMMIT;
