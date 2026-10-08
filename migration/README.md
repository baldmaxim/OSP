# Переезд с Supabase в контур su10

Рабочие материалы переезда: Supabase → общий кластер PostgreSQL su10, вход через Keycloak
`auth.su10.ru`, новый домен. Стандарт контура — skill
[`.claude/skills/skill_keycloak_supabase_migration`](../.claude/skills/skill_keycloak_supabase_migration/SKILL.md).

| Путь | Что | Этап |
|---|---|---|
| [`PLAN.md`](PLAN.md) | **канонический** план переезда, ред. 8.1 | все |
| [`REFACTORING.md`](REFACTORING.md) | подробный план рефакторинга: релизы Р0–Р7, гарантии | 2 |
| [`schema/`](schema/README.md) | слепок схемы прода (только DDL) | 0 |
| [`backup/`](backup/README.md) | копия прода, проверка восстановлением, прогон миграций на копии — **перед каждой миграцией** | 2 |
| [`monitoring.md`](monitoring.md) | запросы после выкладки: старые сборки, отказы по разделам | 2 |
| [`inventory/`](inventory/README.md) | SQL инвентаризации Supabase — только чтение, без персональных данных | 0 |
| [`inventory.md`](inventory.md) | итог инвентаризации — материал для СТОП 1 | 0 |
| [`requests/cluster-owner.md`](requests/cluster-owner.md) | заявка владельцу кластера PostgreSQL | 1 |
| [`requests/auth-team.md`](requests/auth-team.md) | заявка команде auth | 1 |
| [`requests/contour-owners.md`](requests/contour-owners.md) | вопросы по хостингу, домену, хранилищу | 0–1 |

## Правила

- **Секреты и персональные данные — никогда в git и в чат:** пароли, ключи, client secret, строки
  подключения, хеши паролей, выгрузки учёток, файлы сопоставления, дампы. Каталоги `out/`, `in/`,
  `dumps/`, `secrets/` и сырые ответы `inventory/results/` — в `.gitignore`.
- **В Supabase — только чтение**, кроме согласованных шагов окон.
- **Любая запись в прод** — сначала `--dry-run` с отчётом; все скрипты можно безопасно повторить.
- **Окна A (перенос базы) и B (вход и домен)** утверждаются отдельно — после стенда, репетиций и
  условий допуска.
