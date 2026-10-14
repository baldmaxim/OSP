# Корпоративный стандарт v3.2: single-VPS baseline для архитектуры, инфраструктуры, аутентификации и эксплуатации порталов

> **Дата проверки версий: 07.10.2026.** Подготовленная редакция на основе v3.1. Архитектура single-VPS сохранена; добавлены точные целевые версии, ограничения совместимости и порядок их допуска.
>
> **Важно:** статус стабильного релиза не означает отсутствие ошибок. Матрица §27 различает базовые кандидаты, условный допуск и компоненты без достаточного подтверждения исправлений. Этот документ не является результатом тестирования конкретного приложения или сканирования его lockfile/контейнеров. Перед production обязательны проверки §28–29.


## 1. Назначение

Документ определяет корпоративный стандарт для web-порталов, backend API, frontend-приложений, фоновых задач, файлового хранения, централизованной аутентификации, deployment, мониторинга и интеграций.

Эта редакция стандарта фиксирует базовый сценарий первичного внедрения: **single-VPS deployment**. На первичном этапе используется один production VPS/VM в Yandex Compute Cloud. На нём размещаются reverse proxy, backend API, workers и Keycloak. Создание второй VPS/VM и Yandex Application Load Balancer на этом этапе **не требуется**.

Такой вариант считается базовым для быстрого и понятного запуска портала, если требования к отказоустойчивости допускают single point of failure на уровне runtime-сервера. При росте нагрузки или требований к доступности архитектура должна расширяться до HA-схемы отдельным инфраструктурным этапом: добавляется вторая VPS/VM, выносится ingress layer в управляемый L7-balancer и включается rolling deployment.

Стандарт фиксирует обязательные архитектурные решения:

- базовую инфраструктуру порталов;
- централизованную аутентификацию через Keycloak;
- интеграцию с Active Directory;
- модель пользователей сотрудников и подрядчиков;
- авторизацию пользователей и сервисов;
- SQL-first миграции;
- фоновые задачи и ретраи;
- загрузку, хранение и удаление файлов;
- transactional email;
- deployment flow;
- observability;
- хранение секретов;
- shared libraries и project templates.

Стандарт не фиксирует внутренние классы, второстепенные библиотеки и конкретные структуры таблиц, если они не влияют на безопасность, совместимость, эксплуатационную надёжность или переносимость между порталами.

---

## 2. Базовая production-архитектура

Базовая схема первичного внедрения — **один production VPS/VM**.

```text
Пользователи
   ↓ HTTPS
DNS A/AAAA records
   ├─ auth.su10.ru
   ├─ auth-admin.su10.ru
   ├─ api.portal-a.ru
   ├─ api.portal-b.ru
   └─ api.portal-c.ru
        ↓ один публичный IP
Yandex Compute Cloud / VPS
   └─ backend-vps-1
        ├─ nginx reverse proxy
        ├─ portal-a-api
        ├─ portal-a-worker
        ├─ portal-b-api
        ├─ portal-b-worker
        └─ keycloak
             ↓
Yandex Managed PostgreSQL
   ├─ portal_a_db
   ├─ portal_b_db
   └─ keycloak_db
        ↓
S3-compatible object storage
```

На первичном этапе **не создаются**:

- вторая backend VPS/VM;
- Yandex Application Load Balancer;
- backend groups для балансировщика;
- rolling update между двумя runtime-нодами.

Публичные домены указывают на один публичный IP `backend-vps-1`. Входящий HTTP/HTTPS-трафик принимает nginx reverse proxy на этой же VPS/VM и маршрутизирует запросы к Keycloak и backend API порталов.

Ограничение single-VPS схемы: отказ `backend-vps-1` приводит к недоступности backend API, workers и Keycloak. Это допустимо только для первичного внедрения или порталов, где такой риск принят владельцем системы. Компенсирующие меры обязательны: backups, restore procedure, мониторинг, алерты, документированный rebuild VPS из Docker images и конфигурации.

Внутренние сотрудники аутентифицируются через Active Directory:

```text
Keycloak на backend-vps-1
   ↓ site-to-site VPN
Active Directory во внутренней сети компании
```

Подрядчики аутентифицируются через локальную базу пользователей Keycloak.

Переход к HA-архитектуре выполняется отдельным этапом и должен включать как минимум вторую VPS/VM, управляемый ingress/load balancing layer, проверку stateless runtime-сервисов и rolling deployment flow.

---

## 3. Ingress layer для single-VPS deployment

В базовой single-VPS схеме ingress layer реализуется через **nginx 1.30.5, stable branch**, на `backend-vps-1`. Версия и ограничения допуска зафиксированы в §27.

Nginx может быть установлен как host-level сервис или запущен как отдельный инфраструктурный Docker Compose project, например:

```text
/opt/infra/nginx/
```

Nginx выполняет:

- TLS termination;
- HTTP → HTTPS redirect;
- маршрутизацию по Host;
- маршрутизацию по path, если необходимо;
- передачу корректных `X-Forwarded-*` headers;
- маршрутизацию к Keycloak;
- маршрутизацию к backend API порталов;
- ограничение доступа к административным endpoint'ам;
- basic rate-limit на публичных endpoint'ах, если требуется;
- access/error logging.

Пример маршрутизации:

```text
auth.su10.ru
  → keycloak:8080

auth-admin.su10.ru
  → keycloak:8080
  → доступ только через VPN/IP allowlist

api.portal-a.ru
  → portal-a-api:3000

api.portal-b.ru
  → portal-b-api:3000
```

Требования к single-VPS ingress:

- наружу публикуются только `80/tcp` и `443/tcp`;
- SSH доступен только через VPN, bastion или IP allowlist;
- порты backend API, workers, Keycloak management port `9000` и PostgreSQL наружу не публикуются;
- внутренние сервисы слушают localhost, private Docker network или private interface;
- TLS-сертификаты выпускаются и обновляются контролируемо;
- `auth-admin.su10.ru` ограничивается на уровне nginx и/или cloud security group;
- request body size, proxy timeout и upload timeout задаются явно;
- для Keycloak передаются корректные proxy headers, чтобы issuer, redirect URI и secure cookies работали через публичный HTTPS-домен;
- конфигурация nginx хранится в infra repository и версионируется.

Yandex Application Load Balancer не является обязательным компонентом первичного внедрения. Он может быть добавлен позже при переходе к HA-схеме, когда появятся две и более runtime-ноды или отдельные требования к управляемому L7-balancing, health checks и отказоустойчивому ingress.

---

## 4. Backend compute layer

Backend-сервисы размещаются на одном production VPS/VM в **Yandex Compute Cloud**.

Базовая production-схема первичного внедрения:

```text
backend-vps-1
```

`backend-vps-1` содержит runtime-сервисы порталов, workers, nginx reverse proxy и Keycloak. Портальные backend API должны оставаться stateless относительно пользовательских запросов: пользовательские файлы хранятся в S3-compatible storage, состояние приложения — в PostgreSQL, сессии и identity — в Keycloak.

На VPS/VM:

```text
/opt/portals/portal-a/
/opt/portals/portal-b/
/opt/infra/keycloak/
/opt/infra/nginx/
```

Базовые версии runtime-инфраструктуры: **Docker Engine 29.8.2** и **Docker Compose plugin 5.6.0**. Используется команда `docker compose`; версии дистрибутивных пакетов и их зависимостей фиксируются в infrastructure inventory.

Каждый портал запускается как отдельный Docker Compose project:

```bash
docker compose -p portal-a up -d
docker compose -p portal-b up -d
```

Keycloak запускается как отдельный инфраструктурный Docker Compose project:

```bash
docker compose -p keycloak up -d
```

Nginx запускается и обновляется отдельно от порталов и Keycloak.

Deployment одного портала не должен затрагивать другие порталы, nginx и Keycloak.

Для подготовки к будущему HA-режиму приложения не должны зависеть от локального диска VPS как от постоянного хранилища пользовательских данных.

---

## 5. Backend application stack

Базовый backend-стек — целевые версии на 07.10.2026:

- Node.js **24.21.0 LTS**;
- TypeScript **7.0.2**, условный допуск; **6.0.3** — только документированное временное исключение для несовместимого tooling;
- Fastify **5.12.5**, с проверками validation и graceful shutdown;
- Drizzle ORM (`drizzle-orm`) **0.45.3**, с обязательной проверкой освобождения DB connections при ошибках транзакций;
- Drizzle Kit (`drizzle-kit`) **0.31.11**;
- jose **6.2.12**;
- pino **10.4.0**;
- zod **4.6.5**.

Матрица §27 и ограничения §28 имеют приоритет над простым указанием номера версии. `drizzle-orm` и `drizzle-kit` версии `1.0.0-rc.*` / `beta.*` в production-baseline не допускаются.

Backend должен обеспечивать:

- runtime validation входных данных;
- structured JSON logging;
- redaction чувствительных данных;
- CORS allowlist при необходимости;
- CSRF-защиту для cookie-based endpoints;
- secure headers;
- rate-limit;
- health endpoints;
- graceful shutdown;
- DB connection pool limits;
- request id / correlation id.

Обязательные endpoints:

```text
GET /health/live
GET /health/ready
```

Для сервисов с метриками:

```text
GET /metrics
```

---

## 6. Frontend application stack

Базовый frontend-стек — целевые версии на 07.10.2026:

- React (`react`) **19.3.0** и `react-dom` **19.3.0**;
- TypeScript **7.0.2**, с теми же условиями и временным исключением **6.0.3**, что и в backend;
- Ant Design (`antd`) **6.6.5**.

Переход Ant Design 5 → 6 выполняется как отдельная миграция UI, а не простая замена номера. Проверяются формы, таблицы, Modal/Drawer, загрузка файлов, темы и кастомные CSS-селекторы. Если установлен `@ant-design/icons`, его обновляют совместно до совместимой ветки 6 или выше с точным pin после проверки; пакет `@ant-design/v5-patch-for-react-19` для Ant Design 6 удаляется. Руководство миграции — [S14].

Frontend взаимодействует с `auth.su10.ru` для login/logout flow и с backend API портала для бизнес-операций.

Frontend не хранит долговременные секреты.

Frontend не выполняет финальную авторизацию. Проверки ролей во frontend используются только для UX.

---

## 7. Yandex Managed PostgreSQL

Основная БД: ** Managed PostgreSQL**. Для новых кластеров целевая major-версия — **PostgreSQL 17**.



Требования:

- подключение только от доверенных backend-сервисов;
- TLS;
- доступ ограничен network/security rules;
- PostgreSQL не публикуется наружу, если это возможно;
- runtime-пользователь имеет минимальные права;
- migration-пользователь имеет DDL-права;
- backups включены;
- PITR используется при наличии такой возможности;
- conn_limit для каждого пользователя задаётся явно.

В single-VPS схеме доступ к PostgreSQL должен быть разрешён только от `backend-vps-1` и доверенных deployment/migration runners.

Рекомендуемая структура:

```text
portal_a_db
portal_b_db
portal_c_db
keycloak_db
```

Пользователи:

```text
portal_a_runtime
portal_a_migration
portal_b_runtime
portal_b_migration
keycloak_runtime
readonly_reporting, если нужен
```

Connection budget рассчитывается до добавления нового портала или DB user.

Пример формулы:

```text
available_user_connections = max_connections - service_reserve - admin_reserve
```

Для каждого приложения:

```text
conn_limit >= runtime_instance_count × process_count × pool.max + reserve
```

Для первичного single-VPS deployment:

```text
runtime_instance_count = 1
```

При переходе к HA-схеме `runtime_instance_count` увеличивается до количества активных VPS/VM, на которых запущены экземпляры backend API или workers.

Pool size backend, worker и Keycloak задаётся явно.

---

## 8. PostgreSQL extensions и миграции

Расширения PostgreSQL в Yandex Managed PostgreSQL включаются вручную до запуска миграций.

Типовой набор:

- `pgcrypto`;
- `citext`;
- `pg_trgm`.

Версии `pgcrypto`, `citext` и `pg_trgm` не фиксируются как независимые npm-пакеты: используются совместимые версии из выбранной сборки managed PostgreSQL. Перед обновлением фиксируются доступные и установленные версии расширений; доступность всех трёх расширений на целевой major проверяется отдельно.

SQL-миграции приложения не должны выполнять `CREATE EXTENSION`.

Миграции:

- выполняются в SQL-first подходе;
- хранятся как versioned SQL files;
- являются источником правды для production schema changes;
- не изменяются задним числом после попадания в общую ветку;
- исправляются новой миграцией;
- применяются отдельным deployment step;
- не запускаются автоматически из backend или worker контейнеров;
- `drizzle-kit push` не используется в production.

Production migrations должны быть безопасны для controlled single-VPS deployment и не должны блокировать будущий переход к rolling deployment.

---

## 9. Keycloak

Keycloak используется как корпоративный Identity Provider. Целевая стабильная версия — **26.8.0**, **с условным допуском для AD/LDAP-контура**.

До обновления обязательны тесты LDAP-маппинга, неизменности идентификаторов пользователей и связей с порталами; см. §28.2. Откат на предыдущую версию без отдельной проверки security fixes и схемы БД не считается безопасным решением.

Публичный домен:

```text
auth.su10.ru
```

Административный домен:

```text
auth-admin.su10.ru
```

`auth-admin.su10.ru` доступен только через VPN или IP allowlist.

В single-VPS baseline Keycloak размещается на той же VPS/VM, что и backend-сервисы, но как отдельный инфраструктурный сервис:

```text
backend-vps-1: keycloak container
```

Keycloak использует отдельную БД:

```text
keycloak_db
```

Keycloak не размещается внутри compose-проектов порталов.

Обязательные требования:

- отдельный DB user;
- отдельные secrets;
- отдельные backups;
- отдельный deploy/update process;
- отдельные health checks;
- memory limit для контейнера;
- resource limits;
- logs и metrics;
- admin access restricted;
- realm export;
- documented restore procedure.

Keycloak management port `9000` не публикуется наружу.

В базовой single-VPS схеме Keycloak не кластеризуется. Недоступность `backend-vps-1` означает недоступность login/logout flow и административного доступа Keycloak. Поэтому обязательны регулярный realm export, backup `keycloak_db`, проверенная процедура восстановления и мониторинг публичного OIDC discovery endpoint.

При переходе к HA-схеме Keycloak deployment должен быть пересмотрен отдельно: добавляется вторая runtime-нода, корректная работа за load balancer, синхронизация настроек и отдельная проверка session/cluster behavior.

---

## 10. Интеграция с Active Directory

Внутренние сотрудники аутентифицируются через Active Directory.

Keycloak интегрируется с AD через LDAP/LDAPS User Federation.

Схема:

```text
Keycloak
   ↓ LDAPS 636
site-to-site VPN
   ↓
Domain Controller во внутренней сети
```

Требования:

- контроллер домена не публикуется в интернет;
- используется LDAPS;
- service account для LDAP bind имеет минимальные права;
- режим LDAP provider: read-only, если изменение пользователей должно выполняться в AD;
- AD groups мапятся в Keycloak groups / client roles;
- состояние disabled/locked пользователя должно учитываться;
- VPN availability мониторится;
- LDAP bind мониторится;
- алерты на недоступность AD обязательны.

Сотрудник вводит доменный логин и пароль на `auth.su10.ru`. Keycloak проверяет пароль через AD и не хранит пароль сотрудника у себя.

---

## 11. Подрядчики

Подрядчики не заводятся в Active Directory.

Подрядчики создаются как local users в Keycloak.

Для подрядчиков используются:

- Keycloak local credentials;
- Keycloak groups;
- Keycloak client roles;
- MFA при необходимости;
- срок действия доступа, если предусмотрено процессом;
- регулярная ревизия доступа.

Пример групп:

```text
/contractors
/contractors/romashka
/contractors/romashka/passdesk-viewer
/contractors/romashka/passdesk-editor
```

Пример client roles:

```text
passdesk.access
passdesk.contractor_viewer
passdesk.contractor_editor
```

---

## 12. Модель ролей и авторизации

Keycloak управляет:

- identity;
- источником пользователя;
- состоянием пользователя;
- SSO session;
- MFA;
- доступом к порталу;
- крупными ролями;
- client roles.

Backend портала управляет:

- бизнес-авторизацией;
- доступом к конкретным объектам;
- связью пользователя с отделом;
- связью пользователя с подрядчиком;
- workflow restrictions;
- временными правами;
- audit бизнес-действий.

Рекомендуемая модель:

```text
Keycloak realm:
  su10

Keycloak clients:
  passdesk
  finance
  warehouse
  hr

Client roles для passdesk:
  access
  admin
  manager
  hr
  contractor_viewer
  contractor_editor
```

Backend портала проверяет:

- JWT signature;
- issuer;
- audience;
- expiration;
- client roles;
- локальные бизнес-права.

---

## 13. Standalone auth mode

Для порталов, которые не подключены к Keycloak, допускается standalone auth mode.

Standalone auth использует:

- access JWT;
- opaque refresh token;
- refresh rotation;
- refresh reuse detection;
- хранение hash refresh token в БД;
- password hashing;
- password reset;
- local MFA, если используется.

Для корпоративных порталов, подключенных к `auth.su10.ru`, локальный password login для внутренних сотрудников отключается.

---

## 14. Machine-to-machine API

Portal-to-portal интеграции используют machine-to-machine схему.

Допускаются два варианта:

```text
1. Keycloak service accounts / client credentials flow
2. существующая machine-to-machine JWT-схема портала
```

При использовании Keycloak предпочтителен client credentials flow.

Каждый service client должен иметь:

- client id;
- secret или private key auth;
- allowed scopes;
- allowed audiences;
- минимальные права;
- audit выдачи и использования.

---

## 15. Файлы и S3-compatible storage

Файловое хранилище:

```text
cloud.ru S3
или
Cloudflare R2
```

Файлы загружаются через upload session и presigned URL.

Порядок:

```text
1. backend создаёт upload session;
2. backend генерирует object key;
3. backend выдаёт presigned URL;
4. frontend загружает файл напрямую в S3-compatible storage;
5. frontend подтверждает завершение загрузки;
6. backend проверяет объект;
7. backend создаёт или активирует file record;
8. backend создаёт фоновые задачи обработки файла.
```

Требования:

- object key генерируется backend;
- object key не строится прямой конкатенацией пользовательского ввода;
- при upload проверяются размер, тип, права пользователя;
- при download проверяются права пользователя и принадлежность файла к объекту;
- удаление выполняется через soft delete;
- физическое удаление из S3 выполняется асинхронно;
- повторное удаление отсутствующего объекта считается успешным.

---

## 16. Фоновые задачи, retries и outbox

Для простых и средних порталов используется:

- PostgreSQL-based jobs;
- transactional outbox;
- idempotency;
- retry с exponential backoff;
- jitter;
- dead-state;
- administrative retry.

Job record должен содержать:

- id;
- type;
- payload;
- status;
- attempts;
- max_attempts;
- next_run_at;
- locked_by;
- locked_until;
- last_error;
- created_at;
- updated_at.

В базовой single-VPS схеме worker-процессы запускаются на `backend-vps-1`. Допускается несколько worker-процессов на одной VPS/VM, если это укладывается в CPU/RAM/DB connection budget.

Захват задачи должен выполняться атомарно через PostgreSQL locking, чтобы без перепроектирования поддержать несколько workers и будущую HA-схему.

Все фоновые задачи должны быть идемпотентными.

Redis/BullMQ рассматриваются только для сценариев, где PostgreSQL jobs недостаточны. Последние подтверждённые стабильные релизы: **Redis 8.10.2** и **BullMQ (`bullmq`, Node.js) 6.3.11**.

**На дату этой редакции Redis не получает автоматического production-допуска:** в публичных High-severity advisories не указаны исправленные версии; необходимы подтверждение исправлений или отдельное согласование применимости и компенсирующих мер (§28.5). PostgreSQL jobs/outbox остаются базовым вариантом. BullMQ не разворачивается без отдельно допущенного Redis.

Сценарии для отдельного рассмотрения:

- высокая пропускная способность очередей;
- большое количество мелких задач;
- delayed jobs;
- repeatable jobs;
- priorities;
- websocket/pubsub;
- high-frequency distributed rate-limit;
- заметная нагрузка jobs на основную БД.

При использовании BullMQ Redis является обязательным runtime-компонентом.

---

## 17. Transactional email

Основной email provider: **Amazon SES**.

Amazon SES используется для transactional email:

- уведомление о входе;
- password reset;
- MFA/security events;
- приглашения подрядчиков;
- workflow notifications;
- уведомления о статусах;
- административные уведомления.

Обязательные требования:

- SPF;
- DKIM;
- DMARC;
- bounce handling;
- complaint handling;
- suppression list;
- audit отправки security-sensitive писем;
- rate-limit;
- шаблоны;
- секреты только в protected secret storage.

Допустимый alternative provider: **Yandex Cloud Postbox**.

Yandex Postbox допускается, если требуется:

- единый Yandex Cloud-контур;
- интеграция с Yandex IAM и Yandex-инфраструктурой;
- SMTP-интерфейс;
- AWS SES-compatible API;
- меньше внешних облачных зависимостей;
- отправка писем через защищённое соединение TLS 1.2+.

Приложения не должны напрямую зависеть от конкретного provider API.

Рекомендуемый общий модуль:

```text
@su10/mail
```

---

## 18. Secrets management

Production secrets хранятся в protected runtime secret storage.

Предпочтительный вариант:

```text
Yandex Lockbox
```

Допустимые варианты:

- protected environment variables;
- Docker secrets;
- secret files с ограниченными правами;
- Vault **2.1.1**, только если выбран вместо основного secret storage;
- иной корпоративный secret manager.

В secret storage хранятся:

- DB connection URL;
- DB passwords;
- Keycloak DB credentials;
- Keycloak admin bootstrap secret;
- OIDC client secrets;
- Amazon SES credentials;
- Yandex Postbox credentials;
- S3/R2 credentials;
- Sentry tokens;
- log HMAC key;
- encryption keys;
- service account secrets;
- SMTP credentials;
- PostgreSQL CA certificate или путь к нему.

Файл `.env` не коммитится в git.

Production-секреты не хранятся в Docker image, frontend-коде, логах или БД.

---

## 19. Deployment

Production deployment выполняется через deploy runner или CI/CD pipeline.

Оператор запускает deployment один раз для конкретного портала и окружения.

Production VPS/VM не выполняет:

```text
git pull
npm install
npm run build
```

Production VPS/VM получает заранее собранный Docker image из registry.

Docker images хранятся в:

```text
Yandex Container Registry
```

Deployment flow для single-VPS baseline:

```text
1. deployment lock;
2. preflight checks;
3. build Docker image from exact commit;
4. push immutable image tag;
5. migration plan;
6. apply SQL migrations one time;
7. update portal API compose project on backend-vps-1;
8. health check API;
9. update/restart portal workers on backend-vps-1;
10. worker health/status check;
11. post-deploy checks;
12. deployment report.
```

На первичном этапе допускается controlled restart конкретного портала на одной VPS/VM. Нулевой downtime и rolling deployment не являются обязательными требованиями single-VPS baseline, но миграции и runtime-код должны проектироваться так, чтобы не блокировать будущий переход к rolling deployment.

Deployment должен быть portal-scoped.

Скрипт деплоя не должен изменять соседние порталы, Keycloak, nginx или другие инфраструктурные сервисы.

Запрещены глобальные destructive-команды:

```text
docker stop $(docker ps -q)
docker system prune -a
docker compose down --volumes
rm -rf /opt/portals/*
```

Keycloak и nginx обновляются отдельными infrastructure deployment процедурами, а не в рамках деплоя бизнес-портала.

Каждый deploy формирует deployment report.

---

## 20. Observability

Используется managed/SaaS-first подход.

В single-VPS baseline особое внимание уделяется мониторингу `backend-vps-1`, потому что на ней находятся backend API, workers, nginx reverse proxy и Keycloak.

Компоненты:

```text
Yandex Monitoring
Yandex Managed Service for Prometheus
Yandex Cloud Logging или Monium Logs
Sentry SaaS
Node Exporter 1.12.1
cAdvisor 0.60.6, если нужны container metrics
nginx access/error logs
Uptime Kuma 2.5.5 или uptime-SaaS
Grafana 13.2.3 для self-hosted dashboards; либо managed/SaaS dashboards
```

### Метрики

Yandex Monitoring используется для облачных ресурсов и базовых метрик VPS/VM.

Yandex Managed Service for Prometheus используется для:

- Node Exporter metrics;
- cAdvisor metrics;
- nginx metrics, если включены;
- Fastify application metrics;
- Keycloak metrics;
- custom technical metrics;
- optional business metrics.

### Логи

Application logs пишутся в JSON через **pino 10.4.0**.

Логи отправляются в:

```text
Yandex Cloud Logging
или
Monium Logs
```

Nginx access/error logs также должны собираться централизованно или быть доступны для диагностики инцидентов.

Из логов удаляются или маскируются:

- пароли;
- Authorization header;
- cookies;
- access tokens;
- refresh tokens;
- client secrets;
- OTP/TOTP values;
- recovery codes;
- private keys;
- presigned URLs;
- request body с ПДн.

### Sentry

Sentry используется как SaaS.

Подключается к:

- backend API;
- workers;
- frontend React.

Требования:

- `sendDefaultPii=false`;
- `beforeSend` redaction;
- server-side data scrubbing;
- source maps upload для frontend;
- release и environment tagging;
- запрет отправки request body с ПДн;
- запрет отправки токенов, cookies, presigned URLs, секретов.

### Uptime

Uptime checks:

```text
https://auth.su10.ru/realms/su10/.well-known/openid-configuration
https://api.portal-a.ru/health/live
https://api.portal-a.ru/health/ready
https://api.portal-b.ru/health/live
https://api.portal-b.ru/health/ready
```

Для single-VPS baseline дополнительно рекомендуется проверять:

```text
https://auth-admin.su10.ru/realms/master/.well-known/openid-configuration
```

если проверка выполняется из VPN/IP allowlist и не раскрывает административный endpoint наружу.

---

## 21. Alerts

Обязательные alerts:

- backend-vps-1 unavailable;
- nginx/reverse proxy unavailable;
- backend service down;
- Keycloak unavailable;
- AD/LDAP unavailable;
- VPN to AD unavailable;
- PostgreSQL connection errors;
- DB connections near limit;
- high 5xx rate;
- high p95/p99 latency;
- worker dead jobs;
- failed deployment;
- disk space low;
- CPU/memory pressure на backend-vps-1;
- TLS certificate expiration;
- container restarts;
- Sentry critical issue;
- SES/Postbox send failures;
- bounce/complaint rate growth;
- refresh token reuse, если используется standalone auth;
- suspicious login failures;
- admin role changes.

Используется один основной alerting control plane:

```text
Yandex Monitoring Alerts
или
Grafana Alerting
```

---

## 22. Audit

Audit log должен фиксировать:

- successful login;
- failed login;
- logout;
- role changes;
- group changes;
- service account changes;
- machine token выдачу;
- password reset;
- MFA events;
- contractor invite;
- contractor disabled;
- critical file errors;
- dead jobs;
- admin actions;
- deployment events.

Email в audit log хранится как HMAC, если хранение email в открытом виде не требуется бизнес-логикой.

---

## 23. Transport security, headers и CORS

Production-порталы доступны только по HTTPS.

В single-VPS baseline TLS termination и HTTP → HTTPS redirect выполняет nginx reverse proxy на `backend-vps-1`.

HTTP перенаправляется на HTTPS.

Базовые security headers:

- Strict-Transport-Security;
- X-Content-Type-Options;
- Referrer-Policy;
- X-Frame-Options или CSP frame-ancestors;
- Content-Security-Policy.

CORS:

- не включается, если frontend и backend находятся на одном origin;
- использует exact allowlist origins, если CORS требуется;
- authenticated API не использует wildcard origin;
- credentials допускаются только с конкретным разрешённым origin.

Порты backend API, Keycloak internal endpoints, worker-процессы и PostgreSQL не публикуются напрямую в интернет.

---

## 24. Shared skills, packages и templates

Общие технические решения не копируются вручную между проектами.

Используются:

```text
portal-template
su10-shared packages
infra-standards repository
agent-skills, если используются AI-агенты
```

### portal-template

Шаблон нового портала:

```text
backend/
frontend/
deploy/
docs/
monitoring/
```

### internal npm packages

Общие runtime-библиотеки:

```text
@su10/config
@su10/logger
@su10/fastify-security
@su10/oidc
@su10/mail
@su10/s3
@su10/jobs
@su10/observability
```

Публичные версии внутренних `@su10/*` пакетов в этой редакции не определяются: конкретные approved-версии берутся из внутреннего registry и lockfile соответствующего портала. Номера внутренних релизов не выдумываются и не заменяются публичным `latest`.

Каждый пакет должен иметь:

- semver;
- changelog;
- tests;
- owner;
- security review для auth/mail/crypto компонентов.

### infra-standards

Хранит:

- deployment scripts;
- Yandex setup docs;
- Keycloak setup docs;
- AD integration docs;
- PostgreSQL connection budget docs;
- monitoring templates;
- runbooks;
- incident procedures.

---

## 25. Production startup checks

При старте production-сервис проверяет:

- наличие обязательных env/secrets;
- отсутствие placeholder/default значений;
- корректность DB URL;
- TLS-настройки подключения к PostgreSQL;
- корректный `NODE_ENV`;
- наличие S3 credentials;
- наличие Sentry config, если включен;
- корректность OIDC issuer/audience;
- отсутствие dev-настроек;
- доступность критичных зависимостей, если это требуется для readiness.

Если критичная настройка отсутствует или небезопасна, сервис завершает запуск с ошибкой.

---

## 26. Обязательный минимум стандарта v3.2

Для каждого production-портала в single-VPS baseline реализуются следующие компоненты. Номера ниже являются целевыми; ограничения §27–29 обязательны, включая временное исключение TypeScript **6.0.3** при несовместимом tooling:

- HTTPS only;
- nginx **1.30.5 stable** или другой отдельно утверждённый ingress layer на `backend-vps-1`;
- один production VPS/VM для первичного внедрения;
- backend API, workers и Keycloak на одной VPS/VM, но в отдельных Docker Compose projects;
- Node.js **24.21.0 LTS** + TypeScript **7.0.2** с условиями §28.1 + Fastify **5.12.5** backend;
- React / react-dom **19.3.0** + TypeScript по §28.1 + Ant Design **6.6.5** frontend;
- Docker Engine **29.8.2** + Docker Compose plugin **5.6.0** на production VPS/VM;
- Yandex Managed PostgreSQL;
- S3-compatible object storage;
- upload через presigned URL;
- SQL-first migrations;
- Drizzle ORM **0.45.3**, с условиями §28.3;
- Drizzle Kit **0.31.11**;
- migration runner как отдельный deployment step;
- PostgreSQL-based jobs/outbox для простых и средних фоновых задач;
- idempotency для повторяемых операций;
- Keycloak **26.8.0** для корпоративного SSO, с условиями §28.2;
- Active Directory integration для внутренних сотрудников;
- Keycloak local users для подрядчиков;
- backend authorization для бизнес-прав;
- Amazon SES как основной transactional email provider;
- Yandex Postbox как допустимый альтернативный provider;
- pino **10.4.0** JSON logs;
- redaction чувствительных данных;
- Sentry SaaS;
- Yandex Monitoring;
- Managed Prometheus для custom metrics при необходимости;
- Cloud Logging или Monium Logs;
- deployment runner;
- immutable Docker image tags;
- deployment report;
- Yandex Container Registry;
- protected secret storage;
- production startup checks;
- audit log критичных событий;
- alerts на VPS, reverse proxy, auth, DB, worker и deployment-события;
- documented backup/restore procedure для `backend-vps-1`, PostgreSQL, Keycloak realm и конфигурации nginx.

Yandex Application Load Balancer и вторая VPS/VM не входят в обязательный минимум первичного внедрения. Они добавляются отдельным HA-этапом при наличии требований к отказоустойчивости, горизонтальному масштабированию или rolling deployment без downtime.



---

## 27. Матрица версий и область применения

**Срез публичных данных: 07.10.2026.** Под «последней стабильной» понимается опубликованный релиз без `alpha`, `beta`, `rc`, `canary`, `next`, `nightly` и `preview`. Для Node.js выбран последний LTS, для nginx — stable branch; это явно обозначенные production-предпочтения, а не утверждение, что более новых веток не существует.

Статус **«База»** означает рекомендованный кандидат после общих проверок §29, а не сертификат безопасности. **«Условно»** означает, что до production требуется закрыть конкретное ограничение §28. **«Не допущен автоматически»** запрещает трактовать номер последнего релиза как одобрение к установке. Опциональные компоненты не становятся обязательными из-за появления версии в таблице.

### 27.1. Основной стек

| Компонент | Целевая версия | Статус | Основание / ограничение |
|---|---|---|---|
| Node.js | **24.21.0 LTS** | База | Самый новый LTS. 26.10.0 — Current, не выбран для production-baseline. [S01], [S02] |
| TypeScript | **7.0.2** | Условно | Compiler API / tooling и incremental cache; временное исключение 6.0.3. §28.1. [S03]–[S05], [R01] |
| Fastify | **5.12.5** | Условно | Security fixes включены; тесты пустого body и завершения запросов обязательны. §28.4. [S06], [R08], [R09] |
| drizzle-orm | **0.45.3** | Условно | Последний стабильный, не 1.0 RC. Риск утечки pool client. §28.3. [S07], [R04] |
| drizzle-kit | **0.31.11** | База | SQL-first миграции; генерация и повторный запуск проверяются на копии БД. [S07] |
| jose | **6.2.12** | База | Регрессионные тесты JWT/JWKS и конфигурации алгоритмов. [S08], [R20] |
| pino | **10.4.0** | База | Проверить redaction и flush используемых transports. [S09], [R21] |
| zod | **4.6.5** | База | Для runtime validation; отдельная проверка JSON Schema/OpenAPI при их генерации. §28.6. [S10], [R10], [R22] |
| react + react-dom | **19.3.0 / 19.3.0** | База | Одинаковая версия пары; проверить библиотеки UI и тесты Suspense. [S11], [S12], [R11] |
| antd | **6.6.5** | База после UI-миграции | Major-переход с 5; требования браузеров, icons и DOM/CSS. [S13], [S14] |
| Keycloak | **26.8.0** | Условно | AD/LDAP и upgrade/restore проверяются отдельно. §28.2. [S15], [S16], [R02] |
| nginx | **1.30.5 stable** | База | Не mainline 1.31.6; проверить TLS/proxy и применяемые модули. [S17], [S18] |
| Docker Engine | **29.8.2** | База | Security release; системные зависимости — из совместимого vendor-набора. [S19] |
| Docker Compose plugin | **5.6.0** | База | Команда docker compose; проверить существующие compose-файлы. [S20] |
| PostgreSQL | **18; upstream 18.6** | Провайдер / отдельная миграция | В managed-сервисе подтвердить реальную сборку и исправления; не обещать доступность точного patch. [S21]–[S24] |

### 27.2. Мониторинг и опциональные компоненты

| Компонент | Целевая версия | Статус | Основание / ограничение |
|---|---|---|---|
| Node Exporter | **1.12.1** | База при использовании | Доступ к metrics только из доверенного контура. [S25] |
| cAdvisor | **0.60.6** | Опционально | Проверить Docker API, cgroups, mounts и объём прав. [S26] |
| Uptime Kuma | **2.5.5** | Опционально | Релиз исправляет утечку памяти TCP monitor; миграция данных и backup обязательны. [S27], [R19] |
| Grafana | **13.2.3** | Опционально, self-hosted | Релиз с security fixes; совместимость plugins/SSO/dashboards. [S28], [R16]–[R18] |
| Redis | **8.10.2** | **Не допущен автоматически** | Последний релиз подтверждён, устранение ряда High-рисков не подтверждено. §28.5. [S29], [R13]–[R15] |
| BullMQ, Node.js | **6.3.11** | Опционально, условно | Не путать с версиями Rust/Python в том же репозитории; только с допущенным Redis. [S30] |
| Vault | **2.1.1** | Опционально | Не добавлять при использовании Lockbox; отдельно проверить миграцию storage/auth plugins. [S31] |

### 27.3. Что не имеет универсального номера версии в этом документе

Yandex Compute Cloud, Managed PostgreSQL как облачный сервис, Lockbox, Container Registry, Monitoring, Managed Prometheus, Cloud Logging/Monium, Amazon SES, Postbox, cloud.ru S3, R2 и Sentry SaaS не заменяются self-hosted аналогами и не получают выдуманные package versions. Для них фиксируются используемые API, настройки и фактические SDK в проекте.

Версии `@su10/*`, DB-драйвера, `@fastify/*` plugins, Sentry/AWS SDK, `@types/*`, сборщика, test runner и package manager нельзя установить по исходному стандарту: package manifests и lockfile не предоставлены. Они подлежат отдельной инвентаризации и точной фиксации, но не объявляются новыми обязательными библиотеками этой редакцией. Добавление `react-dom` только уточняет согласованную пару React runtime.

Для ОС VPS, OpenSSL, Java внутри Keycloak, containerd/runc/BuildKit и системных пакетов проверяется фактический состав образа/хоста. Один актуальный npm-пакет не подтверждает безопасность всего контейнера.

---

## 28. Известные ограничения и условия допуска

### 28.1. TypeScript 7.0.2

TypeScript 7.0 не предоставляет прежний Compiler API; инструменты, импортирующие его, требуют отдельного решения совместимости. Это документированное изменение интерфейса, не CVE. Цель — 7.0.2; для несовместимого tooling разрешено фиксированное временное исключение **6.0.3** после проверки его peer dependencies. Не устанавливать две версии с конфликтующими CLI без явной настройки. [S03]–[S05]

Есть открытое сообщение о некорректном incremental cache при изменении `lib`/`target`. Перед допуском сравнить чистую и incremental-проверки; контрольный CI typecheck выполнять без старого `.tsbuildinfo`. Сообщение имеет статус расследования, а не подтверждённую универсальную неисправность. [R01]

### 28.2. Keycloak 26.8.0 и Active Directory

Руководство обновления меняет обработку binary LDAP attributes. Сообщение #53608 описывает игнорирование `binary.attribute.decoder=uuid` для `objectGUID`; оно открыто и находится на triage. Для своего AD обязательны проверки UUID/base64, полного и повторного sync, групп, disabled/locked users и сохранения связей с порталами. При воспроизведении релиз для данного контура блокируется. [S16], [R02]

Отдельный #53610 касается `email_verified` при внешнем OIDC-brokering, а не прямого LDAPS из этого стандарта. Проверять при наличии такого расширения; не отключать security-проверки для обхода ошибки. [R03]

Предыдущий **26.7.5** нельзя автоматически объявить безопасной заменой: **26.8.0 содержит дополнительные security fixes**. Любое временное исключение требует проверки применимости этих исправлений. До schema upgrade сохраняются согласованные backup БД, конфигурация и исходный image digest; простой запуск старого image на уже обновлённой БД не является планом отката. [S15], [S16], [R24]

### 28.3. Drizzle ORM 0.45.3 / Kit 0.31.11

В #6241 описана утечка соединения при ошибке `BEGIN` в pooled transaction для node-postgres и некоторых других adapters; автор указывает одинаковый проблемный код в 0.45.2 и 0.45.3. Для используемого драйвера выполнить fault-injection на `BEGIN`, disconnect и rollback и доказать освобождение соединения. Если сценарий воспроизводится, допуск блокируется до исправления либо протестированного управления жизненным циклом client. [R04]

Откат на **0.45.1 и ниже** не является безопасным обходом: SQL identifier injection исправлена в **0.45.2**. Стабильная пара — **0.45.3 / 0.31.11**; переход на 1.0 RC ради обхода отдельной ошибки не допускается. [R05], [S07]

### 28.4. Fastify 5.12.5

Версия включает исправление HTTP/2 trailers DoS, для которого указана patched version 5.12.5. Обновление предпочтительнее возврата к старым security-уязвимым версиям. [R09]

Два открытых сообщения требуют приёмочных тестов: незавершённые запросы дополнительного dual-stack listener при `close()` и пустой PUT без `Content-Type` при content-type-specific body schema. Проверить SIGTERM под нагрузкой, прекращение приёма новых запросов и отклонение обязательного отсутствующего body. Явный private bind не должен приводить к публикации API-порта наружу. [R06], [R07]

### 28.5. Redis 8.10.2 / BullMQ 6.3.11

Redis 8.10.2 — security release, но в проверенных бюллетенях **GHSA-c8h9-259x-jff4** и **GHSA-93m2-935m-8rj3** указаны High-риски потенциального выполнения кода и `Patched versions: TBD`. Поэтому подтверждения «исправлено в 8.10.2» нет. Это не доказывает воспроизводимость на конкретной сборке, но исключает безусловный допуск. [S29], [R13], [R14]

Запрет `RESTORE` через ACL указан как мера для первого риска, но **не закрывает второй**. Ещё один бюллетень относится к Lua и writable replicas. Не отключать Lua вслепую в связке с очередями: фактические команды BullMQ и совместимость мер должны быть проверены. При отсутствии подтверждённого решения использовать PostgreSQL jobs/outbox. [R13]–[R15]

### 28.6. Frontend и контракты валидации

Для Ant Design 6 нужны React ≥18 и современные браузеры; при установленном icons требуется совместимое обновление. Проверить UI и отправляемые значения форм, включая Form.List, а не только успешную сборку. [S14]

В Zod #6613 описана потеря ограничений при массовой генерации OpenAPI через сторонний converter; минимального воспроизведения нет, runtime parsing у автора работает корректно. Это не основание объявлять обычный `.parse()` неисправным. При генерации контрактов выполнить diff полного JSON Schema/OpenAPI и негативные тесты. [R10]

Для React 19.3.0 есть открытое сообщение о зависании `act()` с несколькими Suspense boundaries; оно относится к тестовому сценарию. RSC advisories проверять только при наличии server-components/framework, а не автоматически относить к любому React SPA. [R11], [R12]

### 28.7. PostgreSQL и инфраструктурные сервисы

PostgreSQL 18.6 включает security fixes, в том числе для `pgcrypto` и `pg_trgm`. Для существующих данных release notes предусматривают дополнительные проверки: отдельные pgcrypto-сценарии, статистики GIN и индексы некоторых расширений. Нужность этих действий определяется фактическими функциями и индексами; один upgrade binary не всегда завершает исправление. [S22]

nginx 1.30.5 включает исправления опубликованных проблем stable-ветки. Docker 29.8.2 исправляет, в частности, нарушение проверки TLS при обращении к registry. Grafana 13.2.3 следует за исправлениями XSS/распаковки plugins в 13.2.2 и содержит новые security fixes. Это не освобождает от проверки модулей, plugins и системных библиотек. [S18], [S19], [S28], [R17], [R18]

---

## 29. Фиксация версий, проверка и обновление

### 29.1. Воспроизводимость

Прямые runtime-зависимости портала фиксируются точными версиями; полный граф зависимостей — коммитнутым lockfile. CI использует frozen/immutable install. Контейнеры фиксируются по проверенному digest, а не только по изменяемому tag. В production запрещены плавающие `latest`, `next`, wildcard и автоматический переход на новый major. Для shared libraries диапазоны peer dependencies допустимы как объявление совместимости, но не заменяют lockfile приложения.

Для managed PostgreSQL и дистрибутивных пакетов фиксируются фактически установленные версии и vendor build, а не условный номер из примера. Digest, версии ОС и служебных зависимостей не выдумываются заранее.

### 29.2. Общая приёмка каждого обновления

1. **Инвентаризация.** Сохранить текущие manifests, lockfile, image digests, compose/config, версии хоста/БД/расширений и зависимости `@su10/*`. Отдельно определить используемые auth features и DB adapter.
2. **Проверка безопасности.** Проверить весь lockfile, включая build/dev dependencies, и SBOM финальных images свежими базами уязвимостей. Оценить применимость High/Critical; отсутствие advisories в одном репозитории не является доказательством безопасности. Неразрешённые применимые High/Critical блокируют выпуск без оформленного исключения владельца безопасности.
3. **Совместимость.** Проверить engines/peer dependencies, чистую установку, typecheck, сборку, unit/integration/e2e; выполнить специальные тесты §28. Не подавлять ошибки через `--force`, отключение validation или ослабление auth.
4. **Данные и восстановление.** На копии БД проверить SQL migrations, повторный запуск, восстановление и сохранность данных. Для Keycloak, БД, Vault и monitoring-сервисов отдельно проверить совместимость формата данных с процедурой отката.
5. **Нагрузочные и эксплуатационные проверки.** Проверить SSO/LDAPS, JWT/JWKS, logout/refresh, CSRF/CORS, redaction, S3 upload/download, jobs/retry/idempotency, освобождение DB pool и завершение запросов при остановке.
6. **Раздельный deployment.** Сначала тестовый контур и пилотный портал; затем остальные порталы по отдельности. Docker, nginx, Keycloak и major PostgreSQL обновлять отдельными инфраструктурными операциями. Перезапуск Docker daemon на общей VPS не считать portal-scoped действием.
7. **Протокол допуска.** Сохранить точный набор версий, хеш lockfile, digests, результаты тестов/сканирования, оценку применимости advisories, исключения с владельцем и сроком, rollback plan. Только после этого кандидат становится approved для конкретного портала.

### 29.3. Поддержание актуальности

Матрица — датированный срез, а не бессрочное разрешение. Предлагаемый корпоративный порядок: плановая сверка не реже раза в месяц и повторная проверка перед каждым deployment; security fixes рассматриваются вне очереди. Новый patch сначала проверяется и включается в матрицу/lockfile, затем разворачивается. Условные допуски пересматриваются после upstream-исправления или изменения применимости.

---

## Приложение А. Источники проверки

Исходная архитектура и требования: `corp_standard_full_single_vps(2).md`, редакция v3.1, §§1–26. Внешние сведения о версиях и ошибках проверены 07.10.2026. Статусы GitHub issues и advisories могут измениться после этой даты. Сообщение пользователя в issue не приравнивается к подтверждённому maintainer security advisory.

- [S01] Node.js — текущие ветки LTS и Current.
- [S02] Node.js 24.21.0 — release notes.
- [S03] TypeScript 7.0.2 — стабильный релиз.
- [S05] TypeScript 6.0.3 — релиз совместимой ветки.
- [S06] Fastify 5.12.5 — релиз.
- [S07] Drizzle ORM / Drizzle Kit — стабильные и предварительные релизы.
- [S08] jose 6.2.12 — релиз.
- [S09] pino 10.4.0 — релиз.
- [S10] Zod 4.6.5 — релиз.
- [S11] React — актуальные версии.
- [S12] React 19.3.0 — релиз.
- [S13] Ant Design — changelog, 6.6.5.
- [S14] Ant Design — миграция v5 → v6.
- [S15] Keycloak 26.8.0 — релиз и security fixes.
- [S16] Keycloak — руководство по обновлению.
- [S17] nginx — stable/mainline.
- [S18] nginx — security advisories.
- [S19] Docker Engine 29.8.2 — release notes и security fixes.
- [S20] Docker Compose 5.6.0 — релиз.
- [S21] PostgreSQL — поддерживаемые версии.
- [S22] PostgreSQL 18.6 — release notes и действия после обновления.
- [S23] Yandex Managed PostgreSQL — политика обновлений.
- [S24] Keycloak — поддерживаемые версии PostgreSQL.
- [S25] Node Exporter 1.12.1 — релиз.
- [S26] cAdvisor 0.60.6 — релиз.
- [S27] Uptime Kuma 2.5.5 — релиз.
- [S28] Grafana 13.2.3 — релиз.
- [S29] Redis 8.10.2 — security release.
- [S30] BullMQ 6.3.11 — релиз Node.js-пакета.
- [S31] Vault 2.1.1 — релиз и security fixes.
- [R01] TypeScript #64552 — устаревшая диагностика incremental-сборки, открытое сообщение.
- [R02] Keycloak #53608 — LDAP binary.attribute.decoder=uuid, открытое сообщение.
- [R03] Keycloak #53610 — OIDC broker / email_verified, открытое сообщение.
- [R04] Drizzle #6241 — утечка pool client при ошибке BEGIN, открытое сообщение.
- [R05] Drizzle — SQL injection, GHSA-gpj5-g38j-94v9.
- [R06] Fastify #7043 — graceful shutdown дополнительного listener.
- [R07] Fastify #7038 — пустой PUT без Content-Type.
- [R08] Fastify — security advisories.
- [R09] Fastify — HTTP/2 trailers DoS, исправлено в 5.12.5.
- [R10] Zod #6613 — потеря ограничений при генерации большого OpenAPI-документа.
- [R11] React #37556 — act / Suspense, открытое сообщение.
- [R12] React — RSC security advisory и область применимости.
- [R13] Redis — RESTORE, GHSA-c8h9-259x-jff4; patched version: TBD.
- [R14] Redis — unblock client, GHSA-93m2-935m-8rj3; patched version: TBD.
- [R15] Redis — Lua / writable replica, GHSA-8ghh-qpmp-7826; patched version: TBD.
- [R16] Grafana — актуальный каталог security advisories.
- [R17] Grafana — Plugin Extraction Zip Slip, CVE-2026-15815.
- [R18] Grafana — Geomap XSS, CVE-2026-76154.
- [R19] Uptime Kuma — SSTI, исправлено в 2.2.1.
- [R20] jose — security advisories.
- [R21] pino — security advisories.
- [R22] Zod — security advisories.
- [R24] Keycloak 26.7.5 — релиз предыдущей ветки; не универсальная безопасная замена.

[S01]: https://nodejs.org/en/download
[S02]: https://github.com/nodejs/node/releases/tag/v24.21.0
[S03]: https://github.com/microsoft/TypeScript/releases/tag/v7.0.2
[S05]: https://github.com/microsoft/TypeScript/releases/tag/v6.0.3
[S06]: https://github.com/fastify/fastify/releases/tag/v5.12.5
[S07]: https://github.com/drizzle-team/drizzle-orm/releases
[S08]: https://github.com/panva/jose/releases/tag/v6.2.12
[S09]: https://github.com/pinojs/pino/releases/tag/v10.4.0
[S10]: https://github.com/colinhacks/zod/releases/tag/v4.6.5
[S11]: https://react.dev/versions
[S12]: https://github.com/react/react/releases/tag/v19.3.0
[S13]: https://ant.design/changelog/
[S14]: https://ant.design/docs/react/migration-v6/
[S15]: https://www.keycloak.org/2026/10/keycloak-2680-released
[S16]: https://www.keycloak.org/docs/latest/upgrading/index.html
[S17]: https://nginx.org/en/download.html
[S18]: https://nginx.org/en/security_advisories.html
[S19]: https://docs.docker.com/engine/release-notes/29/#2982
[S20]: https://github.com/docker/compose/releases/tag/v5.6.0
[S21]: https://www.postgresql.org/support/versioning/
[S22]: https://www.postgresql.org/docs/release/18.6/
[S23]: https://yandex.cloud/ru/docs/managed-postgresql/concepts/update-policy
[S24]: https://www.keycloak.org/server/db
[S25]: https://github.com/prometheus/node_exporter/releases/tag/v1.12.1
[S26]: https://github.com/google/cadvisor/releases/tag/v0.60.6
[S27]: https://github.com/louislam/uptime-kuma/releases/tag/2.5.5
[S28]: https://github.com/grafana/grafana/releases/tag/v13.2.3
[S29]: https://github.com/redis/redis/releases/tag/8.10.2
[S30]: https://github.com/taskforcesh/bullmq/releases/tag/v6.3.11
[S31]: https://github.com/hashicorp/vault/releases/tag/v2.1.1
[R01]: https://github.com/microsoft/TypeScript/issues/64552
[R02]: https://github.com/keycloak/keycloak/issues/53608
[R03]: https://github.com/keycloak/keycloak/issues/53610
[R04]: https://github.com/drizzle-team/drizzle-orm/issues/6241
[R05]: https://github.com/drizzle-team/drizzle-orm/security/advisories/GHSA-gpj5-g38j-94v9
[R06]: https://github.com/fastify/fastify/issues/7043
[R07]: https://github.com/fastify/fastify/issues/7038
[R08]: https://github.com/fastify/fastify/security/advisories
[R09]: https://github.com/fastify/fastify/security/advisories/GHSA-4mh8-r7rc-xpvc
[R10]: https://github.com/colinhacks/zod/issues/6613
[R11]: https://github.com/react/react/issues/37556
[R12]: https://react.dev/blog/2025/12/11/denial-of-service-and-source-code-exposure-in-react-server-components
[R13]: https://github.com/redis/redis/security/advisories/GHSA-c8h9-259x-jff4
[R14]: https://github.com/redis/redis/security/advisories/GHSA-93m2-935m-8rj3
[R15]: https://github.com/redis/redis/security/advisories/GHSA-8ghh-qpmp-7826
[R16]: https://grafana.com/security/security-advisories/
[R17]: https://grafana.com/security/security-advisories/cve-2026-15815/
[R18]: https://grafana.com/security/security-advisories/cve-2026-76154/
[R19]: https://github.com/louislam/uptime-kuma/security/advisories/GHSA-v832-4r73-wx5j
[R20]: https://github.com/panva/jose/security/advisories
[R21]: https://github.com/pinojs/pino/security/advisories
[R22]: https://github.com/colinhacks/zod/security/advisories
[R24]: https://github.com/keycloak/keycloak/releases/tag/26.7.5
