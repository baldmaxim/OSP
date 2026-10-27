-- Шаблоны разделов — файлы, которые раздел даёт скачать всем: «Шаблон Было-Стало» («Заявка на ДС» → «Документы») и
-- «Шаблон ДГП» («Договоры и ДС» → «Документы», миграция 20261109). «Понятийное соглашение» с 27.10.2026 — ссылка
-- (app_settings 'concept_agreement_template_link'), прежний файл строки tenders_concept_agreement виден до удаления.
-- Строка — якорь для файла, строки заводят миграции. Файл — s3_documents (owner_type 'general',
-- owner_id = id, doc_category 'section_template'); прикрепляет и заменяет только администратор.
-- Права (читает сотрудник, писать некому) — supabase/migrations/20261107_section_templates.sql.
CREATE TABLE IF NOT EXISTS section_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]{1,64}$'),           -- tenders_concept_agreement, dc_was_became, contracts_dgp
    title TEXT NOT NULL CHECK (title <> '' AND length(title) <= 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
