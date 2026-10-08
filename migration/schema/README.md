# Слепок схемы прода (только DDL)

Слепок — это текст всех объектов базы портала: таблицы, колонки, ограничения, индексы, политики RLS,
функции, триггеры, представления, гранты. **Данных в нём нет**, персональных тоже. По нему работают
тесты прав и RPC (`npm run test:db`), и он же — основа схемы для Яндекса.

Собрать схему из миграций нельзя: базовые таблицы (`tenders`, `contracts`, `objects`,
`counterparties` …) создавались не миграциями, а `supabase/schemas/prod.sql` — старая выгрузка
только системных схем Supabase.

## Как снять (на удалённой машине, ~1 минута)

Подключитесь по `ssh kg_claude_new` под своим пользователем (тем же, под которым работает репозиторий
`~/VSCode/Sadovnikov/OSP`). Клиент `pg_dump` 18 там уже установлен.

Понадобятся **project ref** (часть адреса `https://<ref>.supabase.co`) и **пароль базы** (Supabase →
Project Settings → Database). Пароль вводится скрыто: он не попадёт ни в чат, ни в историю команд, ни
в список процессов.

```bash
cd ~/VSCode/Sadovnikov/OSP
read -rp 'project ref: ' REF
read -rsp 'пароль базы Supabase: ' PGPASSWORD; echo
export PGPASSWORD PGSSLMODE=require

pg_dump --schema-only -n public -n auth \
  -h aws-1-eu-north-1.pooler.supabase.com -p 5432 \
  -U "postgres.$REF" -d postgres \
  -f migration/schema/prod-schema.sql

unset PGPASSWORD REF
wc -l migration/schema/prod-schema.sql
```

- Порт **5432** — это session pooler. Transaction pooler (`6543`) для `pg_dump` не подходит.
- Если `pg_dump` пишет `permission denied` про объекты схемы `auth` — повторите без `-n auth` и
  скажите мне: заглушки `auth` я сделаю по текущей версии Supabase.
- Если ругается на адрес хоста — возьмите строку **Session pooler** в Supabase → Connect и подставьте
  её хост и пользователя (пароль — всё так же через `read -rsp`).

## Дальше

Напишите мне, что файл готов. Перед коммитом я проверю его на случайные секреты (ключи в телах
функций и т. п.) — без вывода найденного в чат — и подключу к `test:db`.

Снимать заново перед каждым релизом прав и RPC: одна и та же команда, файл перезаписывается.
