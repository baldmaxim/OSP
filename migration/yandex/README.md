# Миграции базы нового портала (tender.su10.ru, база Яндекса)

Миграции из `supabase/migrations/` сюда не годятся. Они написаны под роли Supabase (`anon`,
`authenticated`, `service_role`), а в базе Яндекса одна учётка-владелец, и права устроены иначе
(`migration/target/sql/load-single-owner.sql`):

- правила по строкам действуют и на владельца (FORCE RLS);
- каждая политика сама проверяет роль из токена;
- служебные функции (SECURITY DEFINER) получают пропуск;
- кому какие таблицы и функции доступны вообще, решает список шлюза `server/osp-api/src/data/allow.json`.

## Как применяется

```bash
# на сервере corp (пользователь corpsu):
cd /opt/portals/osp/src && bash scripts/deploy-server.sh migrate
# на машине сборки — проверка на локальном стенде из копии прода:
bash migration/target/stand.sh up <копия.dump>
bash migration/target/migrate.sh migration/target/reports/stand/stand.env --yes
bash migration/target/stand.sh down
```

`migration/target/migrate.sh` применяет новые файлы по порядку имён, каждый — одной транзакцией. В той же
транзакции, до COMMIT, проходят:

- проверка прав под одну учётку — та же, что `rights.sh --check`: 9 правил и чтение «вживую» без токена;
- проверка самой миграции `<имя>.check.sql`.

Хоть один `FAIL` — откат. Применённое записывается в `osp_meta.schema_migrations` вместе с sha256 файла, а
созданные миграцией таблицы, последовательности и функции — в перечень загрузки `osp_meta.manifest`: по нему
`reset.sh` убирает репетицию целиком (без этого новая таблица считалась бы чужой, и сброс отказывал).
Применённый файл менять нельзя: исправление — новой миграцией. Перед первой записью снимаются копия базы
(`export.sh`) и снимок соседей по кластеру.

## Правила файла

- Имя — `ГГГГММДД_что_делает.sql`, проверка — `ГГГГММДД_что_делает.check.sql`: одна или несколько
  выборок, строки `OK …` / `FAIL …`, выполняется с пропуском — видит все строки.
- Только SQL. Нельзя: `BEGIN` / `COMMIT` / `ROLLBACK` (транзакцию задаёт `migrate.sh`), команды psql
  (`\…`), `CONCURRENTLY`, роли Supabase (`TO authenticated` и т. п.).
- Повтор должен быть безопасен там, где это легко: `IF NOT EXISTS`, `DROP … IF EXISTS` перед созданием.
- Данные меняются явно и проверяются в `.check.sql` (было / стало).
- Если миграция нужна и прежнему порталу (osp.root.sx, Supabase), её Supabase-вариант живёт в
  `supabase/migrations/` отдельно.

## Образцы

**Колонка, индекс, ограничение** — как обычно, правила не затрагиваются:
```sql
ALTER TABLE public.tenders ADD COLUMN IF NOT EXISTS priority smallint;
CREATE INDEX IF NOT EXISTS tenders_priority_idx ON public.tenders (priority);
```

**Новая таблица** — правила включены и действуют на владельца, пропуск служебных функций, политика с
проверкой роли и запись о её ролях:
```sql
CREATE TABLE public.tender_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  tag text NOT NULL,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tender_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY osp_internal ON public.tender_tags FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
-- Пропуск → да; иначе роль из токена И условие (как TO authenticated USING (is_portal_employee())).
CREATE POLICY tender_tags_employees ON public.tender_tags FOR ALL TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_portal_employee())) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_portal_employee())) END);
INSERT INTO osp_meta.policy_roles VALUES ('public', 'tender_tags', 'tender_tags_employees', ARRAY['authenticated']);
-- osp:allow table tender_tags authenticated=select,insert,update,delete
```

Как это проверяется:

- **Обёртка политики.** Проверка прав требует обёртку `CASE WHEN … bypass … role_in(…)` у каждой
  политики, кроме `osp_internal`.
- **Запись о ролях.** Для каждой такой политики нужна строка в `osp_meta.policy_roles`. Политика для
  гостя — `role_in('anon')` и `ARRAY['anon']`: таблица тогда считается публичной витриной.
- **Функции в условии.** Функция-проверка без аргументов (`is_admin()`, `is_portal_employee()`) пишется в
  подзапросе `(SELECT …)` — так она вычисляется один раз на запрос.

**Служебная функция** (SECURITY DEFINER): отметка пропуска, своя проверка входа и прав внутри:
```sql
CREATE OR REPLACE FUNCTION public.tender_tag_count(p_tender uuid) RETURNS bigint
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF NOT public.is_portal_employee() THEN RAISE EXCEPTION 'нет доступа' USING ERRCODE = '42501'; END IF;
  RETURN (SELECT count(*) FROM public.tender_tags WHERE tender_id = p_tender);
END $$;
-- osp:allow rpc tender_tag_count authenticated
```
Отметка `application_name = 'osp:internal'` — у всех SECURITY DEFINER и только у них: так требует
проверка прав.

**Представление** — с правами вызывающего (`WITH (security_invoker = true)`), тогда правила таблиц
действуют как обычно. Представление с правами владельца поверх таблиц с правилами и материализованные
представления (в `osp_private`) — отдельный разговор: проверка прав такое не пропустит.

## Список шлюза

Новая таблица, представление или функция появится в портале только после явного разрешения:
```sql
-- osp:allow table <имя> authenticated=select,insert,update,delete anon=select
-- osp:allow rpc <имя> authenticated,anon
-- osp:allow table <имя> none          -- закрыть
```

Порядок:

1. `node scripts/build-db-allow.mjs` пересобирает `allow.json` с учётом этих строк.
2. `tests/db/gateway-allow.test.mjs` сверяет.
3. На сервере — сначала `migrate`, затем `backend` (или `both`): список шлюза лежит в образе API.
