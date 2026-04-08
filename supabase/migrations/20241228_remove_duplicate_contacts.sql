-- Удаляем дубликаты из contacts, оставляя только первую запись по full_name
DELETE FROM contacts
WHERE id NOT IN (
    SELECT DISTINCT ON (lower(full_name)) id
    FROM contacts
    ORDER BY lower(full_name), created_at ASC
);
