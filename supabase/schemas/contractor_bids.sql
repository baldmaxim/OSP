-- Кабинет подрядчика: расценка ВОР на сайте, заявки на участие, анкета.
-- Источник истины — supabase/migrations/20261102_contractor_bids.sql (база нового портала —
-- migration/yandex/20261102_contractor_bids.sql). Здесь — только таблицы для чтения.
--
-- Права: заявки читают сотрудник и сама организация; цены и анкету — администратор и сама организация;
-- поля анкеты — сотрудник и подрядчик с организацией, правит администратор. Запись заявок, цен и анкеты —
-- только функциями bid_request, bid_decide, bid_rates_save, bid_form_save. Список тендеров кабинета —
-- bid_contractor_tenders(), сводка администратора — bid_admin_overview().

-- Заявка подрядчика на участие с сайта: pending → accepted (инженер сделал участником — строка
-- tender_counterparties) | rejected (расценка закрыта, цены остаются).
CREATE TABLE public.tender_bid_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES public.counterparties(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  requested_by uuid,
  requested_by_name text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_by_name text,
  decided_at timestamptz,
  CONSTRAINT tender_bid_requests_key UNIQUE (tender_id, counterparty_id)
);

-- Цена подрядчика за единицу с НДС по уникальной позиции тендера: вид + ключ наименования (normName) + ключ
-- ед. изм. (normUnit) — так группируются листы «Материалы» / «Работы» файлов ВОР (utils/bidVor.js).
-- Наименование, ед. изм., объём и итог (цена × объём) — слепком на момент ввода.
CREATE TABLE public.tender_bid_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES public.counterparties(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('material', 'work')),
  item_key text NOT NULL,
  unit_key text NOT NULL DEFAULT '',
  name text NOT NULL,
  unit text,
  volume numeric(18,4),
  price numeric(15,2),
  total numeric,
  note text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'history')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT tender_bid_rates_key UNIQUE (tender_id, counterparty_id, kind, item_key, unit_key),
  CONSTRAINT tender_bid_rates_value CHECK (price IS NOT NULL OR note IS NOT NULL)
);

-- Поля анкеты «Квалификационная и контактная информация» (список ведёт администратор): текст или выбор из списка.
-- code = 'vat' — ставка НДС подрядчика (22 / 20 / 10 / 7 / 5 / 0 % / «Без НДС»), участвует в итогах расценки.
CREATE TABLE public.bid_form_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  hint text,
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'select')),
  options jsonb,
  code text CHECK (code IS NULL OR code IN ('vat')),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bid_form_fields_code_key UNIQUE (code)
);

-- Анкета организации по тендеру: { id поля: { label, value } }.
CREATE TABLE public.tender_bid_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES public.counterparties(id) ON DELETE CASCADE,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT tender_bid_forms_key UNIQUE (tender_id, counterparty_id)
);
