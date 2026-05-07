-- Ссылка на коммерческое предложение контрагента (Google/Yandex Drive),
-- которая указывается в раскрывающейся таблице участников тендера.

ALTER TABLE tender_counterparties ADD COLUMN IF NOT EXISTS proposal_link TEXT;

COMMENT ON COLUMN tender_counterparties.proposal_link IS 'Ссылка на коммерческое предложение контрагента (Google/Yandex Drive)';
