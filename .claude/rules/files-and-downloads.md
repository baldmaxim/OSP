---
paths:
  - "src/services/s3.js"
  - "src/api/ospFiles.js"
  - "src/components/S3Document*.jsx"
  - "src/components/FileDownload.jsx"
  - "server/osp-api/src/routes/s3Presign.js"
  - "supabase/functions/s3-presign/**/*"
---
# Файлы и скачивание

- Проверяй права владельца, категории, типа и объёма файла на **сервере**; нельзя разрешать операцию только потому, что на экране есть кнопка.
- Скачивание выполнять через `downloadS3File`/существующие helpers (fetch + blob), без открытия временных вкладок или `location.assign`.
- Секреты S3 и долговременные ключи нельзя передавать браузеру или фиксировать в git. Нельзя кэшировать подписанные ссылки как публичную статику.
- Для нового `owner_type` обновлять необходимые серверные правила и тесты; описание: `docs/claude-reference/files-and-storage.md`.
