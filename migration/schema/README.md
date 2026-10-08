# Слепок схемы прода (только DDL)

Слепок — это текст всех объектов базы портала: таблицы, колонки, ограничения, индексы, политики RLS,
функции, триггеры, представления, гранты. **Данных в нём нет**, персональных тоже. По нему работают
тесты прав и RPC (`npm run test:db`), и он же — основа схемы для Яндекса.

Собрать схему из миграций нельзя: базовые таблицы (`tenders`, `contracts`, `objects`,
`counterparties` …) создавались не миграциями, а `supabase/schemas/prod.sql` — старая выгрузка
только системных схем Supabase.

## Как снять (на удалённой машине, ~2 минуты)

Подключитесь по `ssh kg_claude_new` под своим пользователем (тем же, под которым работает репозиторий
`~/VSCode/Sadovnikov/OSP`). Клиент `pg_dump` 18 там уже установлен.

**Пароль базы.** Supabase → **Database** (иконка базы слева) → **Settings** → «Database password».
Текущий пароль Supabase не показывает — его можно только сбросить (**Reset password**, затем зелёная
кнопка подтверждения и сообщение об успехе). Портал, функции и cron паролем базы не пользуются, на
пользователей сброс не влияет. Пароль никуда не сохраняйте: при следующей надобности сбросьте снова.

**Подключение** — только через session pooler (IPv4): прямой адрес `db.<ref>.supabase.co` доступен лишь
по IPv6, а у удалённой машины IPv6 нет. Строку можно сверить в Supabase → **Connect** → Direct →
Session pooler.

Одна последовательность — проверка, слепок, копия с данными (каждый шаг только после успеха
предыдущего):

```bash
cd ~/VSCode/Sadovnikov/OSP
read -rsp 'пароль базы Supabase: ' PGPASSWORD; echo
echo "длина: ${#PGPASSWORD}"          # сверить с длиной пароля; значение не выводится
export PGPASSWORD PGSSLMODE=require PGCONNECT_TIMEOUT=15

psql -h aws-1-eu-north-1.pooler.supabase.com -p 5432 \
  -U postgres.jxbuimrosrmmjroojdza -d postgres -X -At -c 'select version()' \
&& pg_dump --schema-only -n public -n auth \
  -h aws-1-eu-north-1.pooler.supabase.com -p 5432 \
  -U postgres.jxbuimrosrmmjroojdza -d postgres \
  -f migration/schema/prod-schema.sql \
&& wc -l migration/schema/prod-schema.sql \
&& bash migration/backup/backup.sh

unset PGPASSWORD
```

- Порт **5432** — session pooler. Transaction pooler (`6543`) для `pg_dump` не подходит.
- **`password authentication failed` сразу после сброса пароля** — пулер Supabase несколько минут помнит
  прежний пароль. Не сбрасывайте снова: подождите и повторите одну попытку через 2–3 минуты. Частые
  попытки подряд временно блокируют IP (`Circuit breaker open`, до ~2 минут, каждая новая попытка
  продлевает) — блокируется только эта машина, не проект и не портал.
- Если `pg_dump` пишет `permission denied` про объекты схемы `auth` — повторите без `-n auth`.

## Дальше

Напишите мне, что файл готов. Перед коммитом я проверю его на случайные секреты (ключи в телах
функций и т. п.) — без вывода найденного в чат — и подключу к `test:db`.

Снимать заново перед каждым релизом прав и RPC: одна и та же команда, файл перезаписывается.
