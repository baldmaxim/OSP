-- Контакт площадки по объекту и подразделению ВОР — «Тендеры — Основное строительство» → «Документы раздела»
-- → «Контакт площадки». ФИО, телефон и Telegram подставляются в письмо подрядчикам по объекту и подразделению
-- тендера; без контакта письмо не формируется. Одна строка на объект и подразделение.
-- Триггер «кто изменил», права (читает сотрудник, назначает только администратор — is_admin()) —
-- supabase/migrations/20261030_site_contacts.sql.
CREATE TABLE IF NOT EXISTS object_site_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    division TEXT NOT NULL                                                  -- коды tenders.vor_division
      CHECK (division IN ('monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical', 'finishing')),
    full_name TEXT NOT NULL CHECK (full_name <> '' AND length(full_name) <= 200),
    phone TEXT NOT NULL CHECK (phone <> '' AND length(phone) <= 100),
    telegram TEXT CHECK (telegram IS NULL OR length(telegram) <= 200),     -- @имя, ссылка t.me или номер
    created_by UUID DEFAULT auth.uid(),
    updated_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT object_site_contacts_object_division_key UNIQUE (object_id, division)
);
