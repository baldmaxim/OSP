# Files And Storage — проектный справочник

> **Справочник, а не инструкция постоянной загрузки.** Ниже сохранено исходное описание проекта, включая историю решений и возможные устаревшие варианты. При противоречии ориентироваться на текущий код, миграции, тесты, новую задачу и корневой `CLAUDE.md`.

## Просмотр Word и Excel в окне файла (13.11.2026)

[S3DocumentPreview](src/components/S3DocumentPreview.jsx) показывает .docx (DocxPreview, тот же безопасный разбор, что во вкладке договора) и
Excel ([SheetPreview](src/components/SheetPreview.jsx): листы вкладками, объединённые ячейки, начало большого листа), «Скачать» — в шапке; тип —
`previewKind` ([filePreview.js](src/utils/filePreview.js)), по базе, а без неё — по расширению. Повод — «Отчёт по документам» в `/dc-requests`:
глазик был только у PDF и картинок, а отчёты почти все .docx (64 из 68 на копии прода 02.11); глазик ([DcRequestDocChip](src/components/DcRequestDocChip.jsx))
теперь у PDF, картинок, Word и Excel во всех частях заявки. Реестр договоров: красной полосы у номера нет (13.11.2026 — у договоров без даты, 24.11.2026 — совсем:
у договора без номера дата обычно тоже пустая); незаполненное видно надписями «№ не присвоен» и «дата не указана».

## S3 Document Storage (cloud.ru)

Task 277. Универсальное хранение файлов в S3-совместимом хранилище cloud.ru (bucket `osp`). Архитектура: браузер → Supabase Edge Function `s3-presign` → presigned URL → cloud.ru. Секреты живут только на стороне Edge Function, в браузер не попадают.

### Components

- Таблица `s3_documents` — единая для всех разделов. Привязка через `(owner_type, owner_id)`. Поддерживаемые типы: `'tender'`, `'contract'`, `'object'`, `'customer'`, `'general'` (расширяется в `FOLDER_BY_OWNER` в edge-функции).
- Edge Function `supabase/functions/s3-presign/index.ts` — операции `upload` / `download` / `delete`. Требует Authorization (Supabase JWT).
- **Переезд (заход Б):** с флагом `ospApiFilesV2` файлы идут через свой API — `/api/fn/s3-presign` в
  [server/osp-api](server/osp-api/README.md): ключ операции (UUIDv7 = `s3_documents.id`) делает повтор
  безопасным, удаление — сначала строка, затем объект, загрузка и удаление проверяют право раздела
  (`osp_can`). Фронт — [src/api/ospFiles.js](src/api/ospFiles.js); `services/s3.js` выбирает путь в начале
  операции, вызовы страниц не меняются.
- Frontend сервис [src/services/s3.js](src/services/s3.js): `uploadFile`, `fetchDocuments`, `requestDownloadUrl`, `deleteDocument`, `deleteS3Object`.
- **Обложки объектов — миниатюрой** (03.11.2026: «долгая прогрузка фото»; миграции нет): `/general/objects` показывал оригиналы (до 3,3 МБ на карточку в 300 px), и каждая обложка шла переадресацией на новую подпись cloud.ru — браузеру нечего было запомнить; замер: 0,3 с переадресация + 2,1–2,4 с файл, при каждом открытии. Теперь `objectPhotos.thumbUrl(url)` → `/api/covers/<имя>/thumb` (только у адресов своего API; бакет Supabase — как есть), сервер — [coverThumbs.js](server/osp-api/src/lib/coverThumbs.js), подробности — `server/osp-api/README.md`. Показывать обложку — [ObjectCover в ObjectsPage](src/pages/ObjectsPage.jsx): не отдалась — оригинал. Кэш разрешён только маршруту миниатюры и только в `location ^~ /api/covers/` — остальной `/api/` остаётся `no-store`, подписанные ссылки не запоминать. Прогрев (03.11, позже: «у коллеги стало медленнее, у меня быстро»): память службы пуста после каждой выкладки, первый зашедший ждал хранилища 1,8–3 с на обложку (не успели за 5 с — ещё и оригинал), следующие получали за 0,3 с; теперь служба сама читает обложки в память через 3 с после запуска (`warmCoverThumbs`, `OSP_COVER_WARM=0` — выключить). Тесты — `tests/osp-api/covers.test.mjs`, `minio.test.mjs`, `tests/tender/objects-covers.test.mjs` (стенд `__navigate('/general/objects')`), через настоящий nginx — `tests/deploy/docker.test.mjs`.
- **Скачивание файла — только `downloadS3File(s3Key, fileName)`** ([FileDownload.jsx](src/components/FileDownload.jsx), 29.10.2026:
  «чтобы визуально не обновлялась страница при нажатии скачки в любом месте сайта»): байты — fetch по подписанной ссылке,
  сохранение — blob (file-saver) под нужным именем; ни новой вкладки, ни перехода. Ссылку на файл в `target=_blank`,
  `window.open` или `location.assign` для скачивания не открывать: вкладка открывалась и сразу закрывалась — окно мигало,
  страница на возврате перечитывала данные (visibilitychange). Файл дольше 0,4 с — плашка внизу справа с ходом и отменой;
  повторное нажатие на тот же файл второй не качает; ошибка — исключением (сообщение — у вызывающего), отмена — `false`.
  Тест — `tests/tender/file-download.test.mjs` (стенд: `__fakeRemoteFiles` — хранилище на другом домене, `__fakeFileDelay`).
  Документ по ссылке — `downloadLinkFile(link, имяПоУмолчанию)` там же (30.10): ссылка Google Docs / Таблиц / Презентаций →
  `…/export?format=docx|xlsx|pptx` (у Word-файла, открытого в Google, — тот же файл байт в байт), файл Диска →
  `drive.usercontent.google.com/download` ([linkDownload.js](src/utils/linkDownload.js)); Google разрешает чтение со
  страницы (CORS), если доступ — «все, у кого есть ссылка»; имя — из `Content-Disposition` (`filename*`). Запрос без куки и
  адреса страницы; закрытый документ — исключение с причиной. Первое место — «Скачать ДП» в окне письма подрядчикам
  «Тендеров — Основное строительство» (вместо «Закрыть», окно закрывается крестиком; ссылка — `contracts_dp_template_link`,
  читается при каждом открытии окна; у других направлений «Закрыть» как раньше). Тест — `tests/tender/letter-dp-download.test.mjs`.
- Универсальный UI-компонент [src/components/S3DocumentList.jsx](src/components/S3DocumentList.jsx): список + загрузка + удаление + превью. Принимает props `{ownerType, ownerId, title, canEdit?}`. По умолчанию `canEdit = isEmployee`, подрядчики только смотрят.
- **Папки по дню загрузки** (19.11.2026, решение пользователя): проп `dateFolders` у `S3DocumentList`, пока только «Должная осмотрительность» карточки контрагента (`/general/counterparties` → «Документы»). Папка — `s3_documents.folder_date`, если файл положили в неё явно, иначе календарный день `created_at` по часам браузера (как в колонке «Когда»), поэтому прежние файлы сразу лежат по папкам; новая папка раскрыта, прежние свёрнуты, в строке — время (файл, положенный в прежнюю папку другим днём, — с датой загрузки). «Загрузить» кладёт в папку сегодняшнего дня. **В уже существующую папку** (тот же день, миграция 20270220, обе базы): «+ в папку» в строке папки (на телефоне — сразу за датой) и перетаскивание файлов на папку (подсветка и подсказка «Отпустите — файлы лягут в папку …»); брошенное на список вне папок — в сегодняшнюю; брошенное мимо списка браузер не открывает (на время показа списка). Прежняя папка — днём в `folder_date` (osp-api `confirm`: `folder_date`, настоящая дата с 2000 г. и не позже завтра; прежний портал — в строке при вставке); сегодняшняя — без него. Колонки нет (`'folder_date' in строка` — нет) — у прежних папок кнопки нет, брошенное на них ложится в сегодняшнюю; сервер с полем на базе без колонки отвечает 409 `OSP_NO_FOLDER_DATE`, а не кладёт молча в сегодняшнюю. `created_at` не подменяется (от него «Когда» и отметки ДО в реестрах). Правила — [docDateFolders.js](src/utils/docDateFolders.js), тест — `tests/tender/doc-date-folders.test.mjs`; проверка — `migration/backup/checks/20270220.sql`, откат — `migration/rollback/20270220_s3_documents_folder_date_rollback.sql`.
- **Версии файлов** (26.11.2026, решение пользователя, «ВОРы и РД»): проп `versions` у `S3DocumentList` — ВОР тендера (`vor_statement`, окно «ВОРы и РД» и вкладка тендера) и ВОР заявки без тендера (`general`/`vor_request_vor`); список сервера — `VERSIONED_CATEGORIES` в `s3Presign.js`. Группа — `s3_documents.version_group_id` (миграция 20270307, обе базы; NULL — файл без версий). Номер не хранится: порядок по `created_at`, затем `id` внутри группы, последняя — текущая; удалили версию — номера подряд. Группа из одного файла — обычный файл (так помечен файл, который сделали самостоятельным). Новая версия — кнопкой у файла, перетаскиванием файла с компьютера на строку или из «Загрузить» (похожее имя без отметок редакции — выбор «новая версия / отдельный файл», `suggestVersionGroup`); строку можно перетащить на другой файл или на полосу «самостоятельный»; без мыши — кнопка «Версии». Сервер: `confirm` с `version_of`, действие `version` (право как у удаления, тот же владелец и категория; без колонки — 409 `OSP_NO_VERSIONS`); база — триггер `s3_documents_version_guard` (в группе только файлы одного списка). Связанное: кабинет подрядчика видит только текущую версию (`bid_vor_superseded` + `withoutOlderVersions` в `readTenderFiles`), снабжение кладёт новую версию в ВОР прежней (`supplyAutoImport.targetNameForFile`, `vorFilesForImport`), связь версий главнее отметки снабжения `prior_document_ids`; счётчики «Документы (N)» считают файлы, а не версии. Правила — [docVersions.js](src/utils/docVersions.js) (общий с osp-api); тесты — `tests/tender/doc-versions*.test.mjs`, `tests/supply/auto-import.test.mjs`, `tests/osp-api/server.test.mjs` («версии файлов»); откат — `migration/rollback/20270307_s3_document_versions_rollback.sql`.
- **Ход загрузки и сторож** (19.11.2026: пользователь — загрузка в ДО «зависла на первом», затем «на 4-м файле»). **Найденная причина:** у серверного клиента хранилища (`defaultDeps.createS3`, server/osp-api/src/app.js) не было сроков, а он один на службу и держит соединения открытыми (keep-alive): запрос по соединению, оборванному по дороге без уведомления, ждал без конца — подтверждение загрузки (`HeadObject` в `confirm`) висело до 504 от nginx (180 с), затем повтор. Воспроизведено на «молчащем» сервере: прежний клиент ждёт бесконечно. Теперь установка соединения — до 5 с, тишина в сокете — до 20 с, SDK повторяет на новом соединении (тест — `tests/osp-api/s3-timeouts.test.mjs`). Журнал службы этого не покажет: обычные запросы osp-api не пишет (`disableRequestLogging`). Во всех `S3DocumentList` на кнопке — «Загрузка: 45 %», несколько файлов — «Файл 2 из 5 · 45 %», затем «сохранение». Отправка в хранилище — [storagePut.js](src/api/storagePut.js) (XMLHttpRequest с ходом): нет движения 90 с — обрыв (`StorageStalledError`, как сбой сети) и повтор с новой ссылкой, после трёх попыток — ошибка файла «Хранилище не отвечает…», остальные файлы идут дальше. Запросы `s3-presign` ждут ответа до 60 с (`callOspFunction` с `timeoutMs`) и повторяются (ключ операции один на файл — повтор безопасен). `uploadFile({ …, folderDate, onProgress })` — оба пути (osp-api и прежний). Стенд UI отдаёт XHR на поддельное хранилище тому же `window.fetch` (`__fakeUploadSteps` — ход шагами). Тесты — `tests/osp-api/client.test.mjs`. Во всех списках загрузка нескольких файлов не обрывается на первой ошибке, в конце — список незагруженных.
- Модалка просмотра [src/components/S3DocumentPreview.jsx](src/components/S3DocumentPreview.jsx) — PDF через iframe, изображения через `<img>`, прочие типы — fallback с кнопкой скачать. Окно почти во весь экран (`.s3-doc-preview`: до 1800px, поля 12px; 28.10, было 1100×800) — одно на весь сайт; каркас `.s3-doc-modal` общий с другими окнами (ВОРы и РД, заявки ВОР), его размер не трогать.
- **Переименование файла в окне просмотра** (02.11.2026, решение пользователя; миграции нет): рядом с именем — кнопка «Переименовать» с карандашом. Меняется только подпись — `s3_documents.file_name`; ключ объекта в хранилище прежний, просмотр не перезагружается. **Расширение менять нельзя** (правится имя без него): по расширению просмотр выбирает PDF или картинку, а расценка снабжением узнаёт Excel-файл ВОР; привязка ВОР и цены идут по id файла (`targetNameForFile`) и переименованием не задеваются. Правила имени — [fileRename.js](src/utils/fileRename.js), общие со службой (`SHARED_FILES`). Кнопка есть, только если родитель передал `onRenamed(строка)`: передаёт тому, кто вправе удалять файлы этого списка, и сам обновляет имя у себя (перечитывание с «Загрузка…» не годится — окно открыто). **В «Заявках на ДС» кнопки нет** (`onRenamed` не передаётся; 03.11) — там надпись правится в строке файла, см. ниже. Новое место с `S3DocumentPreview` — решить про `onRenamed`; кабинету подрядчика его не передавать. Сервер: osp-api, действие `rename` (право — как у удаления, `rulesForDoc`; барьер записи); прежний портал — прямая правка строки под правилом сотрудника. Слепки имени не переписываются: `tender_supply_sources.file_name` (расценка показывает живое имя файла), журнал «Расчёта ПЗ», реестр КП (`source_doc_name` — при пересчёте, на экране сразу). Тесты — `tests/tender/file-rename.test.mjs` (стенд `/stand/file-list`), `tests/osp-api/server.test.mjs` («переименование»).
- **Строка файла в «Заявках на ДС»** (03.11.2026, решение пользователя; миграции нет): [DcRequestDocChip](src/components/DcRequestDocChip.jsx). Нажатие на надпись — правка прямо в строке (ОК / Enter, Отмена / Escape; щелчок мимо ничего не закрывает и не пишет), двойное нажатие — скачать, первое нажатие ждёт второе 300 мс; значки просмотра и скачивания остались. Надпись — описание (`notes`), а его нет — имя файла: правится то, что написано (на копии прода 15.10 описание — у 804 файлов из 892; после правки только имени в строке не менялось бы ничего). Имя — без расширения, по правилам `fileRename.js`; описание — osp-api, действие `describe` (право — как у удаления, до 500 знаков, только `owner_type='dc_request'`: у других файлов `notes` — служебные данные), прежний портал — прямая правка строки; пустое описание снимается, в строке снова имя файла. Право — `canEdit('dc_requests')`; без него нажатие открывает просмотр PDF и картинки. Тест — `tests/tender/dc-request-doc-chip.test.mjs`.

### Usage example

```jsx
import S3DocumentList from '../components/S3DocumentList'

<S3DocumentList ownerType="tender" ownerId={tenderId} title="Документы" />
```

S3-ключ объекта формируется автоматически: `{folder}/{owner_id}/{uuid}-{file_name}`.

### Environment variables (root `.env`)

Все переменные — и фронта (Vite), и Edge Function — лежат в одном файле `.env` в корне репо. Шаблон — [.env.example](.env.example). Файл `.env` игнорируется git'ом (паттерн `.env*` в `.gitignore`).

| Переменная | Назначение |
|------------|-----------|
| `VITE_SUPABASE_URL` | Endpoint Supabase, читается фронтом |
| `VITE_SUPABASE_ANON_KEY` | Публичный ключ Supabase, читается фронтом |
| `S3_ENDPOINT` | Endpoint S3 (`https://s3.cloud.ru` для cloud.ru) |
| `S3_REGION` | Регион бакета (`ru-central-1`) |
| `S3_BUCKET` | Имя бакета (`osp`) |
| `S3_ACCESS_KEY_ID` | Access Key ID для S3 |
| `S3_SECRET_ACCESS_KEY` | Secret Access Key для S3 |
| `ANTHROPIC_API_KEY` | Ключ Claude API для Edge Function `ai-assist` (см. раздел «ИИ-помощник») |

`SUPABASE_URL` и `SUPABASE_ANON_KEY` без префикса `VITE_` Supabase инжектирует в runtime функции автоматически — указывать не нужно.

### Edge Function deployment (one-time setup)

1. Установить Supabase CLI: `npm i -g supabase` (или `scoop install supabase`).
2. `supabase login` и `supabase link --project-ref <project-ref>` в корне репо.
3. Скопировать `.env.example` → `.env` в корне и заполнить (см. таблицу выше).
4. Локально (для разработки функции):
   ```bash
   supabase functions serve s3-presign --env-file .env
   ```
5. Деплой на прод:
   ```bash
   supabase secrets set --env-file .env
   supabase functions deploy s3-presign
   ```

`supabase secrets set --env-file .env` пушит **все** ключи из `.env` как секреты функции — `VITE_SUPABASE_*` тоже улетят, но не используются и вреда не приносят.

### CORS на бакете cloud.ru

В консоли cloud.ru: Object Storage → бакет `osp` → раздел «Разрешения» / «Настройки» → секция «CORS». Возможны два формата ввода: JSON-массив правил или форма с полями.

#### Готовый JSON

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:5173",
      "http://osp.root.sx",
      "https://osp.root.sx",
      "https://tender.su10.ru"
    ],
    "AllowedMethods": [
      "GET",
      "PUT",
      "HEAD"
    ],
    "AllowedHeaders": [
      "*"
    ],
    "ExposeHeaders": [
      "ETag"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

#### Поля по отдельности (если UI — форма)

| Поле | Значение | Зачем |
|------|----------|-------|
| **AllowedOrigins** | `http://localhost:5173`, `http://osp.root.sx`, `https://osp.root.sx`, `https://tender.su10.ru` | dev-сервер Vite, прежний портал (Supabase) в обеих схемах и новый портал с базой Яндекса (сервер corp, `migration/CUTOVER.md`). |
| **AllowedMethods** | `GET`, `PUT`, `HEAD` | `PUT` — загрузка по presigned URL; `GET` — скачивание / iframe-preview; `HEAD` — некоторые preflight'ы. `DELETE` напрямую с браузера не идёт — через Edge Function. |
| **AllowedHeaders** | `*` | Браузер при PUT шлёт `Content-Type`, `x-amz-*`. Если cloud.ru не принимает `*` — перечислить: `Content-Type`, `Authorization`, `x-amz-acl`, `x-amz-content-sha256`, `x-amz-date`, `x-amz-security-token`. |
| **ExposeHeaders** | `ETag` | `Content-Length` / `Content-Type` уже CORS-safelisted и доступны JS-у без явного экспонирования. |
| **MaxAgeSeconds** | `3600` (1 час) | Кэш preflight-ответа. |

#### Проверка после сохранения

```bash
curl -i -X OPTIONS https://s3.cloud.ru/osp \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: PUT"
```
Должен вернуться `200` с заголовками `Access-Control-Allow-Origin: http://localhost:5173` и `Access-Control-Allow-Methods: GET, PUT, HEAD`.

### Adding a new owner type

1. Добавить ключ в `FOLDER_BY_OWNER` в [supabase/functions/s3-presign/index.ts](supabase/functions/s3-presign/index.ts)
   и в osp-api ([server/osp-api/src/routes/s3Presign.js](server/osp-api/src/routes/s3Presign.js)): `FOLDER_BY_OWNER`,
   таблицу владельца в `OWNER_TABLES` и право в `WRITE_RULES` — как гейт загрузки в интерфейсе.
2. Передавать новый `ownerType` в `<S3DocumentList>` (или в `uploadFile`) и добавить место загрузки в
   `tests/osp-api/lib/upload-sites.mjs` — иначе `npm run test:api` упадёт.
3. Никаких миграций БД не нужно — `owner_type` это свободный TEXT.

## ИИ-помощник по протоколу разногласий (Edge Function `ai-assist`)

Подсказка юристу по конкретному пункту договора во вкладке «Согласование». Архитектура та же, что у S3: браузер → Edge Function → Claude API. Ключ Anthropic живёт только в секретах функции, в браузер не попадает.

- Edge Function [supabase/functions/ai-assist/index.ts](supabase/functions/ai-assist/index.ts) — `action='clause_suggest'`, модель `claude-opus-5`, требует Authorization (Supabase JWT), как `s3-presign`.
- Frontend сервис [src/services/aiAssist.js](src/services/aiAssist.js): `suggestClause({mode, clauseLabel, ourText, counterpartyText, finalText, counterpartyName, contract, comments})` + список режимов `AI_MODES`.
- UI — модалка `AiSuggestModal` внутри [src/components/ContractClausesTab.jsx](src/components/ContractClausesTab.jsx), кнопка «ИИ» на пункте видна только сотруднику (`isEmployee`).

Режимы (`mode`): `compromise` — компромиссная редакция пункта, `reply` — ответ подрядчику (позиция + текст), `risks` — разбор рисков редакции подрядчика. В модель уходит только этот пункт и переписка по нему. Результат — черновик: вставить в итоговую редакцию или отправить в обсуждение решает человек.

**Деплой** (после `supabase link`, разово):

```bash
supabase secrets set ANTHROPIC_API_KEY=<claude-api-key>
supabase functions deploy ai-assist
```

Без секрета функция отвечает 500 «ANTHROPIC_API_KEY не задан в секретах функции».

## Открыть папку в проводнике (помощник osp-folder, 28.10.2026)

Нажатие на путь к папке (`\\сервер\папка` или `X:\папка`) открывает её в проводнике Windows: [FolderPathCell](src/components/FolderPathCell.jsx)
(тендеры, договоры, планы затрат, карточка договора), путь заявки на ДС, «Открыть» в карточке общей папки раздела
([RootFolderPathButton](src/components/RootFolderPathButton.jsx)). Сам браузер на `file://` и UNC со страницы по https не
переходит (Chrome и Edge блокируют молча), поэтому — своя схема `osp-folder:<encodeURIComponent(путь)>` и помощник на
компьютере:

- **Помощник** — [public/tools/osp-folder.cmd](public/tools/osp-folder.cmd), один файл: пакетная часть запускает себя в
  `wscript` как JScript. Двойной щелчок — установка для текущего пользователя без прав администратора (копия в
  `%LOCALAPPDATA%\OSP\osp-folder.js`, схема в `HKCU\Software\Classes\osp-folder`), повторно — переустановить или
  удалить, ключ `/uninstall`. Открывает только папки локальной сети (имя без точки, 10/172.16–31/192.168, домены
  `SERVER_DOMAINS` в файле) — до обращения к диску: обращение к чужому серверу отдаёт ему данные входа Windows; файл
  по пути не запускает, а выделяет в папке. Файл — ES3 (JScript 5.8), кириллица вне комментариев — кодами `\uXXXX`
  (WSH читает ANSI), CRLF (`.gitattributes`). Скачивается со страницы (`/tools/osp-folder.cmd`).
- **Сайт** — [FolderOpen.jsx](src/components/FolderOpen.jsx) (`openFolder(path)`; окно и подсказка — в своём корне в
  `<body>`), [folderOpen.js](src/utils/folderOpen.js). Стоит ли помощник, из браузера не узнать (без него ничего не
  происходит): в первый раз в этом браузере — окно «скачать помощник / открыть папку / скопировать путь», после
  «Открыть папку» (`localStorage` `osp:folderHelperReady`) — сразу и подсказка «Не открылась?». Не Windows или не путь к
  папке Windows — нажатие как раньше (развернуть путь); копирование осталось кнопкой.
- Тест — `tests/tender/folder-open.test.mjs` (помощник на подделках WScript и реестра, разбор ES3; стенд: «Заявки на ДС»
  и реестр тендеров с Windows-строкой браузера).

