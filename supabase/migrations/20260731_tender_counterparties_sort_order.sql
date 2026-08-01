-- Порядок участников тендера (task 427).
--
-- Раньше список контрагентов-участников не имел порядка (Postgres возвращал как
-- есть), и № были чисто позиционными. Добавляем sort_order, чтобы инженер мог
-- перетаскивать участников (например отказавшихся — вниз). Порядок общий для
-- обоих мест показа: страница списка тендеров (раскрытие) и карточка тендера.

ALTER TABLE tender_counterparties
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- Бэкфилл существующих: по времени приглашения, шаг 10 (запас под вставки/перестановки).
WITH ordered AS (
  SELECT id,
         (row_number() OVER (PARTITION BY tender_id ORDER BY invited_at NULLS LAST, id)) * 10 AS so
  FROM tender_counterparties
)
UPDATE tender_counterparties t
SET sort_order = o.so
FROM ordered o
WHERE o.id = t.id;

CREATE INDEX IF NOT EXISTS idx_tender_counterparties_sort
  ON tender_counterparties(tender_id, sort_order);

COMMENT ON COLUMN tender_counterparties.sort_order IS 'Порядок участника в списке тендера (drag-and-drop). Шаг 10.';
