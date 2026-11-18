---
paths:
  - "server/osp-api/**/*"
---
# Безопасность osp-api

- Для новых маршрутов обязательны `config.access`, схемы входа zod, а открытые URL перечисляются только в `src/open-routes.js`; без `config.access` маршрут не регистрируется.
- Перед расширением DB gateway проверить разрешённые таблицы/RPC (`src/data/allow.json`, `db-sections.json`), карту прав и запреты для подрядчиков (`allow-contractor.json`, `allow-self-contractor.json`). Не заменять проверку прав сокрытием кнопки на клиенте.
- Изменения файловых маршрутов проверять через правила владельца/категории и `tests/osp-api/`; новые типы файлов должны пройти соответствующие ограничения шлюза.
- Утилиты, общие между браузером и API, синхронизируются `node scripts/sync-osp-api-shared.mjs`; проверь `tests/osp-api/shared-sync.test.mjs`.
- Дополнения и исключения: `server/osp-api/README.md` и `docs/claude-reference/operations-and-security.md`.
