# Наблюдение после выкладки

Работает после миграции `supabase/migrations/20261007_client_telemetry.sql`. Запросы — в Supabase SQL
Editor; персональных данных в ответах нет (только id пользователей, сборки и коды).

## Сколько вкладок на старых сборках

Перед удалением старого на сервере (политики, путь, грант) должно быть 0 активных за последние сутки на
сборках старше текущей. Плюс лог nginx — вкладки, открытые до страховочного релиза (см.
`docs/DEPLOYMENT.md`, «Уровень совместимости»).

```sql
select build_id,
       count(*)                                                as users,
       count(*) filter (where last_seen_at > now() - interval '1 day') as active_24h,
       max(last_seen_at)                                       as last_seen
from public.client_versions
group by build_id
order by build_id desc;
```

## Отказы по разделам за последний час

Смотреть в первые часы после каждой выкладки. Рост `42501` / `403` в каком-то разделе — кого-то
заблокировало правами; `PGRST*` — ошибка запроса или схемы; `57014` — таймаут; `http_5xx` — сбой
сервера.

```sql
select section, code, status,
       count(*)                as events,
       count(distinct user_id) as users,
       min(at)                 as first_at,
       max(at)                 as last_at
from public.client_errors
where at > now() - interval '1 hour'
group by section, code, status
order by events desc;
```

Тот же запрос с фильтром по сборке — сравнить новую и прежнюю:

```sql
select build_id, section, code, count(*) as events
from public.client_errors
where at > now() - interval '24 hours'
group by build_id, section, code
order by build_id desc, events desc;
```
