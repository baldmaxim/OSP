# 05. Контракт с командой auth

Realm su10 и учётки Keycloak ведёт команда auth. Портал присылает заявки и файлы и получает обратно
решения. Портал не правит realm и не обращается к Admin API.

## 1. Разделение работ
| Шаг | Портал | Auth |
|---|---|---|
| Клиент `<portal>` | заявка (§2) | заводит клиента, роль `access`, мапперы, плитку; передаёт секрет |
| Список учёток | выгружает и шифрует `su10-portal-users` (§3) | расшифровывает |
| Сопоставление | — | сопоставляет с Keycloak, разбирает спорные случаи, **принимает решения** |
| Недостающие учётки | — | заводит с прежним bcrypt-хэшем из Supabase, `id` = `legacyUserId` |
| Доступ | — | выдаёт роль `<portal>:access` всем со связью |
| Решения | применяет `su10-portal-mapping` (§4) через `apply-mapping` | выпускает файл, новые версии — по вопросам и конфликтам |
| После переезда | передаёт список 403 `pending_mapping` | выпускает новую версию файла |

## 2. Заявка на клиента (шаблон)
```
Портал: <Название>                  client-id: <portal>
Прод:   https://<portal-domain>
Стенд:  https://stage.<portal-domain>          (если есть)
Callback:     https://<portal-domain>/api/auth/oidc/callback  (+ стенд)
Post-logout:  https://<portal-domain>/                         (+ стенд)
Web origins:  https://<portal-domain>                          (+ стенд)
Гейт: client-роль <portal>:access
Плитка в витрине auth.su10.ru: название, одна строка описания, URL
Получатель секрета: <ФИО/контакт>, канал: <защищённый канал>
Даты: репетиционный раунд <…>, окно переключения <…>
```
Клиент заводится по образцу действующих порталов:
- confidential, Standard flow, PKCE S256, без direct grant;
- точные redirect URI и web-origins, без `*`;
- мапперы: audience `aud=<portal>`, `email`, `preferred_username`, client-роли в
  `resource_access.<portal>.roles` (access token);
- секрет генерирует Keycloak. Его не присылают в чат, почтой открытым текстом и не кладут в git.

## 3. Портал → auth: `su10-portal-users`
**Конверт** (общий для обоих направлений; код — `03-identity-mapping.md` §3):
```json
{
  "format": "su10-portal-users",
  "version": 1,
  "createdAt": "2026-10-20T09:00:00.000Z",
  "users": 412,
  "contentSha256": "<sha256 открытого JSON>",
  "kdf": { "name": "scrypt", "N": 32768, "r": 8, "p": 1, "salt": "<base64>" },
  "cipher": { "name": "aes-256-gcm", "iv": "<base64>", "tag": "<base64>" },
  "data": "<base64: aes-256-gcm(gzip(открытый JSON))>"
}
```

**Открытый JSON:**
```json
{
  "portal": "<portal>",
  "round": "rehearsal",
  "exportedAt": "2026-10-20T09:00:00.000Z",
  "source": "supabase:<project-ref>",
  "ownerColumns": ["documents.created_by", "projects.owner_id"],
  "users": [
    {
      "legacyUserId": "6f1c…-uuid",
      "email": "I.Petrov@example.ru",
      "firstName": "Иван Сергеевич",
      "lastName": "Петров",
      "fullName": "Петров Иван Сергеевич",
      "status": "active",
      "createdAt": "2025-03-01T10:00:00Z",
      "lastSignInAt": "2026-10-18T07:12:00Z",
      "providers": ["email"],
      "passwordHash": "$2a$10$…",
      "ownedRecords": 42
    }
  ]
}
```
| Поле | Правило |
|---|---|
| `round` | `rehearsal` или `final` |
| `legacyUserId` | `auth.users.id`, он же внутренний `users.id` портала |
| `email` | как в Supabase, без нормализации; `null`, если нет |
| `firstName` / `lastName` | соглашение su10: `firstName` = «Имя Отчество», `lastName` = фамилия; `null`, если не известны точно |
| `fullName` | исходная строка ФИО, если есть; разбор — на стороне auth |
| `status` | `active` / `banned` / `deleted` / `unconfirmed` |
| `providers` | из `auth.identities`: `email`, `google`, … |
| `passwordHash` | только bcrypt (`$2a$`/`$2b$`/`$2y$`), иначе `null` |
| `ownedRecords` | сумма по `ownerColumns`; помогает auth решать, кого переносить |

## 4. Auth → портал: `su10-portal-mapping`
Конверт тот же, `format: "su10-portal-mapping"`, `users` = число строк. Открытый JSON:
```json
{
  "portal": "<portal>",
  "mappingVersion": 3,
  "issuer": "https://auth.su10.ru/realms/su10",
  "basedOn": { "round": "final", "contentSha256": "<sha256 списка, по которому решали>" },
  "createdAt": "2026-10-27T18:00:00Z",
  "rows": [
    { "legacyUserId": "…", "sub": "…", "decision": "linked_existing" },
    { "legacyUserId": "…", "sub": "…", "decision": "imported" },
    { "legacyUserId": "…", "sub": "…", "decision": "imported_no_password" },
    { "legacyUserId": "…", "sub": null, "decision": "not_migrated", "note": "уволен" },
    { "legacyUserId": "…", "sub": null, "decision": "duplicate_of", "duplicateOf": "…" },
    { "legacyUserId": "…", "sub": null, "decision": "pending", "note": "уточняем email" },
    { "legacyUserId": "…", "sub": "…", "decision": "relink", "previousSub": "…" }
  ]
}
```
- **Версии.** `mappingVersion` монотонно растёт. Каждая версия — **полный** набор решений по всем
  пользователям из последнего списка.

| `decision` | Что сделал auth в Keycloak | Что делает портал | Чем входит пользователь |
|---|---|---|---|
| `linked_existing` | учётка уже была (обычно сотрудник из ФОТ); выдал `access` | связь `legacyUserId ↔ sub` | email + **пароль ФОТ** |
| `imported` | завёл учётку с bcrypt-хэшем из Supabase, `id` = `legacyUserId`; выдал `access` | связь (`sub` = `legacyUserId`) | email + **прежний пароль портала** |
| `imported_no_password` | завёл без пароля (вход был через OAuth или хэша нет); выдал `access` | связь | временный пароль от администратора auth |
| `not_migrated` | ничего | связи нет; записи остаются за прежним id | не входит |
| `duplicate_of` | ничего (основная учётка — в строке `duplicateOf`) | перенос владения на основную (`03` §5) | — |
| `pending` | решение отложено | связи нет; при входе 403 `pending_mapping` | после новой версии файла |
| `relink` | учётку пересоздали, `sub` сменился | замена `previousSub` → `sub` | как раньше |

## 5. Сроки и каналы
- **Репетиционный раунд** — заранее (ориентир: за 1–2 недели до окна). Его цель — выявить спорные
  случаи, например разные email у одного человека в портале и в ФОТ. Auth отвечает версией файла,
  портал прогоняет `apply-mapping --dry-run` на стенде.
- **Финальный раунд** — во время заморозки Supabase. Он включает новых пользователей и изменённые
  пароли. Длительность обработки на стороне auth согласовать до окна: от неё зависит длина окна.
- **Канал.**
  - Зашифрованные файлы можно передавать любым рабочим каналом.
  - Пароль шифрования — **другим** каналом, один раз на миграцию.
  - Открытые файлы и пароль не попадают в git, тикеты и чаты.
- **Хранение.** После закрытия миграции файлы и пароль удаляются по договорённости сторон.

## 6. Пароли — что говорить пользователям
- **Сотрудники, которые есть в ФОТ** (`linked_existing`): логин — рабочий email, пароль — **от ФОТ**, не
  от портала.
- **Заведённые из Supabase** (`imported`): прежний пароль портала. После первого входа Keycloak
  перехэширует его, пользователь ничего не заметит.
- **Без пароля** (`imported_no_password`) и все, кто забыл пароль: пароль выдаёт администратор auth.
  Самостоятельного сброса нет, SMTP в контуре не настроен.
- Пароль меняется в личном кабинете `auth.su10.ru`, а не в портале.
