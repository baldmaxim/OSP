-- АВАРИЙНЫЙ ОТКАТ 20270115_bid_form_company (только база Яндекса): анкета снова без связи с «Моей компанией» — каждый тендер отдельно
-- (как до миграции); страница без колонок scope / source и без таблицы ответов о компании работает по-прежнему.
-- Данные: ответы в анкетах тендеров остаются; таблица bid_company_answers остаётся (повторное применение миграции продолжит с ней),
-- чтение закрыто — политика убрана, остаётся только пропуск служебных операций. Колонки полей анкеты убираются вместе со связями —
-- после повторного применения связи по умолчанию проставятся заново, а выбранные администратором — нет.
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.bid_company_save(jsonb);
DROP POLICY IF EXISTS bid_company_answers_read ON public.bid_company_answers;
DELETE FROM osp_meta.policy_roles WHERE schema_name = 'public' AND table_name = 'bid_company_answers' AND policy_name = 'bid_company_answers_read';

DROP INDEX IF EXISTS public.bid_form_fields_source_key;
ALTER TABLE public.bid_form_fields DROP CONSTRAINT IF EXISTS bid_form_fields_source_check;
ALTER TABLE public.bid_form_fields DROP CONSTRAINT IF EXISTS bid_form_fields_scope_check;
ALTER TABLE public.bid_form_fields DROP COLUMN IF EXISTS source;
ALTER TABLE public.bid_form_fields DROP COLUMN IF EXISTS scope;

COMMIT;
