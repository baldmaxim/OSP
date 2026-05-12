-- Добавляем значение 'attachment' в ENUM object_document_type.
-- Используется для приложений к договорам/допсоглашениям.
-- ADD VALUE IF NOT EXISTS — повторное применение безопасно.

ALTER TYPE object_document_type ADD VALUE IF NOT EXISTS 'attachment';
