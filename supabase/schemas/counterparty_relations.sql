-- Связи между контрагентами (одна компания под разными юрлицами)
CREATE TABLE counterparty_relations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
    related_counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT no_self_relation CHECK (counterparty_id <> related_counterparty_id),
    CONSTRAINT unique_relation UNIQUE (counterparty_id, related_counterparty_id)
);

CREATE INDEX idx_counterparty_relations_cid ON counterparty_relations(counterparty_id);
CREATE INDEX idx_counterparty_relations_rcid ON counterparty_relations(related_counterparty_id);

ALTER TABLE counterparty_relations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated users" ON counterparty_relations
    FOR ALL TO authenticated
    USING (true) WITH CHECK (true);
-- security fix (20260614_fix_rls_public_access): опасная политика "Allow all for anon users"
-- удалена — внутренняя таблица не должна быть доступна anon.
