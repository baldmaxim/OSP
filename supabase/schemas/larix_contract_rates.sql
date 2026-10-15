-- Договорные расценки из Larix.CPM (ВОР по договорам) — вкладка «Договорные расценки (Larix)» реестра
-- расценок. Справочно; источник истины — supabase/migrations/20261018_larix_contract_rates.sql (там же
-- функции загрузки larix_sync_begin / add_rows / finish / fail и права).
-- Пишет только загрузка osp-api (служебный ключ); читает вошедший с osp_can('rates_registry', 'view').

-- Строки реестра «как в КП»: позиция ВОР даёт строку материалов и строку работ (цена > 0).
CREATE TABLE IF NOT EXISTS larix_contract_rates (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id BIGINT NOT NULL,                  -- загрузка, которой записана строка
    item_type TEXT NOT NULL,                 -- 'material' | 'work'
    item_name TEXT NOT NULL,                 -- work_title
    unit TEXT,                               -- measure_title
    price NUMERIC NOT NULL,                  -- цена за единицу этого вида (> 0)
    price_material NUMERIC,                  -- обе цены позиции — для выгрузки
    price_work NUMERIC,
    vat_rate NUMERIC,                        -- ставка НДС, если Larix её отдаёт
    materials_used TEXT,
    comment TEXT,
    project_id BIGINT,
    project_name TEXT,
    contractor_id BIGINT,
    contractor_name TEXT,                    -- contractor_short_name
    contract_id BIGINT,                      -- id договора в Larix (…/contract/<id>)
    contract_number TEXT,
    contract_date DATE,                      -- по Москве
    contract_state TEXT,                     -- отображаемый статус («Заключен» …)
    object_type TEXT,                        -- «Договор» / ДС
    osp_contract_id UUID                     -- наш договор по contracts.document_link (однозначно)
);

-- Журнал загрузок: running | ok | held (данные не заменены) | failed.
CREATE TABLE IF NOT EXISTS larix_sync_runs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_by TEXT NOT NULL DEFAULT 'schedule',   -- 'schedule' | 'cli'
    status TEXT NOT NULL DEFAULT 'running',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    positions_count INTEGER,
    rows_count INTEGER,
    skipped_count INTEGER,
    larix_contracts INTEGER,
    matched_contracts INTEGER,
    error_code TEXT,      -- login | http | timeout | too_large | invalid | db | stale | empty | shrink
    error_text TEXT,      -- без логина, пароля и токена, ≤ 300 символов
    response_keys TEXT[], -- имена полей ответа Larix (без значений)
    filters JSONB         -- списки фильтров вкладки: projects, contractors, contracts, states
);

-- Порции текущей загрузки (удаляются после замены).
CREATE TABLE IF NOT EXISTS larix_sync_stage (
    run_id BIGINT NOT NULL REFERENCES larix_sync_runs(id) ON DELETE CASCADE,
    chunk_no INTEGER NOT NULL,
    rows JSONB NOT NULL,
    PRIMARY KEY (run_id, chunk_no)
);
