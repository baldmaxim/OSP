---
paths:
  - "src/components/supply/**/*"
  - "src/utils/supply*.js"
  - "src/utils/vorMaterials*.js"
  - "tests/supply/**/*"
  - "server/osp-api/src/lib/supply*.js"
---
# Расценки снабжения

- Сохраняй совпадение нормализации и сопоставления между JS и SQL (`normName`, `material_key`, похожесть): после правки требуются профильные тесты `tests/supply/` и, если нужно, миграция.
- Цены и суммы, версии ВОР, источники цены и `row_version` связаны; не перезаписывай ручную цену автоматической и не теряй чужую параллельную правку.
- Крупные ВОР/Excel разбирать только необходимыми листами; избегать загрузки огромных таблиц в React без виртуализации.
- См. `docs/claude-reference/supply-pricing.md`; для смежного реестра КП — `rates-and-larix.md`.
