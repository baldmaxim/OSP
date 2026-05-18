-- Task 262: переносим в смету тендера готовую группировку из Excel.
-- SheetJS отдаёт уровень структуры (outline level) каждой строки в ws['!rows'][i].level.
-- Сохраняем его, чтобы воспроизвести ту же многоуровневую группировку (разделы/подразделы/позиции).

ALTER TABLE tender_estimate_items
    ADD COLUMN IF NOT EXISTS outline_level INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN tender_estimate_items.outline_level IS 'Уровень группировки из Excel (ws.!rows[i].level): 0 — верхний, больше — глубже';
