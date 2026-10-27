-- Шаблоны разделов — файлы, которые раздел даёт скачать всем: «Понятийное соглашение» («Тендеры — Основное
-- строительство» → «Документы раздела» → «Материалы») и «Шаблон Было-Стало» («Заявка на ДС» → «Документы»).
-- Строка — якорь для файла, строки заводят миграции. Файл — s3_documents (owner_type 'general',
-- owner_id = id, doc_category 'section_template'); прикрепляет и заменяет только администратор.
-- Права (читает сотрудник, писать некому) — supabase/migrations/20261107_section_templates.sql.
CREATE TABLE IF NOT EXISTS section_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]{1,64}$'),           -- tenders_concept_agreement, dc_was_became
    title TEXT NOT NULL CHECK (title <> '' AND length(title) <= 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
