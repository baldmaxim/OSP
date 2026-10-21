-- Комплекты РД тендера или заявки на ВОР — раскрывающийся список под строкой в «ВОРах и РД» (/vors).
-- № п/п не хранится: порядковый номер в списке (sort_order, затем created_at).
-- Триггер «кто изменил», права (читает сотрудник, пишет правка «Тендеров» или «ВОРов и РД» —
-- vor_rd_can_edit()) — supabase/migrations/20261027_vor_rd_sets.sql.
CREATE TABLE IF NOT EXISTS vor_rd_sets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tender_id UUID REFERENCES tenders(id) ON DELETE CASCADE,
    vor_request_id UUID REFERENCES vor_requests(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    rd_set TEXT NOT NULL DEFAULT '' CHECK (length(rd_set) <= 500),       -- «Комплект РД», вписывается вручную
    vor_ready BOOLEAN NOT NULL DEFAULT false,                              -- «ВОР готов»: да / нет
    vor_due_date DATE,                                                     -- «Срок выдачи ВОРа»
    link TEXT CHECK (link IS NULL OR (length(link) <= 2000 AND link ~* '^(https?://\S|\\\\\S)')), -- http(s) или \\сервер\папка
    note TEXT CHECK (note IS NULL OR length(note) <= 4000),               -- «Примечание»
    created_by UUID DEFAULT auth.uid(),
    updated_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Владелец — ровно один: тендер или заявка на ВОР без тендера.
    CONSTRAINT vor_rd_sets_owner_check CHECK (num_nonnulls(tender_id, vor_request_id) = 1)
);

CREATE INDEX IF NOT EXISTS vor_rd_sets_tender_idx ON vor_rd_sets (tender_id, sort_order) WHERE tender_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vor_rd_sets_request_idx ON vor_rd_sets (vor_request_id, sort_order) WHERE vor_request_id IS NOT NULL;
