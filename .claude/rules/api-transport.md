---
paths:
  - "src/api/**/*.{js,jsx}"
  - "src/services/**/*.{js,jsx}"
---
# Граница фронтенда и сервера

- Вызывающий код работает через `src/api/`; только адаптеры могут создавать и вызывать Supabase-клиент. `npm run check:transport` должен находить 0 нарушений.
- Сохраняй контракт `db.from(...)/db.rpc(...)` и ответ `{ data, error, count }` для обоих режимов (Supabase и osp-api).
- Для списка, способного превысить 1000 строк, используй `fetchAllRows` / `fetchAllRowsParallel` с устойчивой сортировкой и финальным `id`; `.limit(5000)` не снимает потолок PostgREST.
- Отдельно проверяй права, охват объектов и совместимость базы до/после миграции; детали в `docs/claude-reference/database-and-api.md`.
