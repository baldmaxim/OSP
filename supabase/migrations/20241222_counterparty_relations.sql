-- Связи между контрагентами (одна компания под разными юрлицами)
CREATE TABLE counterparty_relations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
    related_counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Не допускаем дубли и самоссылки
    CONSTRAINT no_self_relation CHECK (counterparty_id <> related_counterparty_id),
    CONSTRAINT unique_relation UNIQUE (counterparty_id, related_counterparty_id)
);

-- Индексы для быстрого поиска связей в обе стороны
CREATE INDEX idx_counterparty_relations_cid ON counterparty_relations(counterparty_id);
CREATE INDEX idx_counterparty_relations_rcid ON counterparty_relations(related_counterparty_id);

-- RLS
ALTER TABLE counterparty_relations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated users" ON counterparty_relations
    FOR ALL TO authenticated
    USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon users" ON counterparty_relations
    FOR ALL TO anon
    USING (true) WITH CHECK (true);
