#!/usr/bin/env bash
# Копия базы портала в Яндексе (после переноса под одну учётку). Только чтение; чужие базы не трогает.
#
#   bash migration/target/export.sh <файл подключения>
#   bash migration/target/export-verify.sh migration/dumps/yandex-<время>     # проверка восстановлением
#
# Обычный pg_dump данных здесь не годится: правила по строкам действуют и на владельца, а отметку
# служебной операции через пулер Яндекса можно поставить только командой внутри транзакции. Поэтому:
#   • структура — pg_dump без данных, двумя частями: до данных (таблицы, функции) и после (индексы,
#     ограничения, триггеры, политики);
#   • данные — все таблицы одним снимком: одна транзакция REPEATABLE READ READ ONLY с отметкой
#     служебной операции, каждая таблица — отдельным файлом; учётные записи Supabase Auth (osp_vault) —
#     в той же транзакции, со своей отметкой osp:vault (отметка служебных функций их не открывает);
#   • перечень — число строк и контрольная сумма каждой таблицы из того же снимка; значения счётчиков.
# Каталог копии: <BACKUP_OUT_DIR или migration/dumps>/yandex-<время UTC>, права 700/600, вне git.
# В вывод — только имена таблиц и числа. Выход: 0 — копия снята; 1 — ошибка запуска; 2 — нет
# подключения; 3 — это не закреплённая база или права под одну учётку не применены; 4 — сбой копирования.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib/conn.sh
. "$HERE/lib/conn.sh"
ENV_FILE="${1:-}"
[ -n "$ENV_FILE" ] || { echo "Использование: bash migration/target/export.sh <файл подключения>" >&2; exit 1; }
for bin in psql pg_dump sha256sum; do command -v "$bin" >/dev/null || { echo "Нужен $bin" >&2; exit 1; }; done
target_conn "$ENV_FILE" || exit 1
export PGAPPNAME=osp-export

pin_rc=0; target_pin_check "$ENV_FILE" || pin_rc=$?
case "$pin_rc" in
  0) ;;
  2) echo "FAIL нет подключения: отпечаток базы не прочитан"; exit 2 ;;
  *) echo "FAIL база не закреплена или это другая база — копия не снимается"; exit 3 ;;
esac
if ! mark="$(psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -c "select status, rights from osp_meta.load_log order by id desc limit 1" 2>/dev/null)"; then
  echo "FAIL в базе нет отметки загрузки"; exit 3
fi
IFS=$'\t' read -r STATUS RIGHTS <<< "$mark"
[ "$RIGHTS" = single ] || { echo "FAIL права под одну учётку не применены (отметка: $RIGHTS) — этот способ копии для них"; exit 3; }

umask 077
OUT="${BACKUP_OUT_DIR:-$ROOT/migration/dumps}/yandex-$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$OUT/data"
fail() { echo "FAIL $1"; rm -rf -- "$OUT"; exit 4; }
first_error() { grep -m 1 -E 'ERROR:|FATAL:|error:' "$1" | sed -E 's/\([^)]*\)/(…)/g' | target_mask | cut -c1-200; }

# 1. Структура.
for section in pre-data post-data; do
  pg_dump --schema-only --no-owner --no-acl --section="$section" -f "$OUT/$section.sql" 2>"$OUT/err" || fail "структура ($section): $(first_error "$OUT/err")"
done

# 2. Данные и перечень — одним снимком.
tables="$(psql -X -q -At -v ON_ERROR_STOP=1 -c "
  select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r' and n.nspname in ('public', 'auth', 'osp_meta', 'osp_private', 'osp_vault')
    and n.nspname ~ '^[a-z_][a-z0-9_]*$' and c.relname ~ '^[a-z_][a-z0-9_]*$' order by 1" 2>"$OUT/err")" || fail "список таблиц: $(first_error "$OUT/err")"
odd="$(psql -X -q -At -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname in ('public', 'auth', 'osp_meta', 'osp_private', 'osp_vault') and not (c.relname ~ '^[a-z_][a-z0-9_]*\$')")"
[ "$odd" = 0 ] || fail "в базе есть таблицы с необычными именами ($odd): копия была бы неполной"
{
  echo '\set ON_ERROR_STOP on'
  echo 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'
  echo "SET LOCAL application_name = 'osp:internal';"
  manifest_of() { # $1 — условие на схему, $2 — файл
    echo "\\copy (select n.nspname || '.' || c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text, (xpath('/row/h/text()', query_to_xml(format('select coalesce(md5(string_agg(h, '''' order by h)), ''-'') as h from (select md5(t::text) as h from %I.%I t) x', n.nspname, c.relname), false, true, '')))[1]::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and $1 order by 1) to '$2'"
  }
  manifest_of "n.nspname in ('public', 'auth', 'osp_meta', 'osp_private')" "$OUT/manifest.main.tsv"
  echo "\\copy (select format('select pg_catalog.setval(%L, %s, true);', schemaname || '.' || sequencename, last_value) from pg_sequences where last_value is not null order by 1) to '$OUT/sequences.sql'"
  while IFS= read -r t; do
    if [ -n "$t" ] && [ "${t%%.*}" != osp_vault ]; then echo "\\copy $t to '$OUT/data/$t.copy'"; fi
  done <<< "$tables"
  echo "SET LOCAL application_name = 'osp:vault';"
  manifest_of "n.nspname = 'osp_vault'" "$OUT/manifest.vault.tsv"
  while IFS= read -r t; do
    if [ "${t%%.*}" = osp_vault ]; then echo "\\copy $t to '$OUT/data/$t.copy'"; fi
  done <<< "$tables"
  echo 'COMMIT;'
} > "$OUT/export.psql"
psql -X -q -f "$OUT/export.psql" >/dev/null 2>"$OUT/err" || fail "данные: $(first_error "$OUT/err")"
LC_ALL=C sort "$OUT/manifest.main.tsv" "$OUT/manifest.vault.tsv" > "$OUT/manifest.tsv"
rm -f -- "$OUT/export.psql" "$OUT/err" "$OUT/manifest.main.tsv" "$OUT/manifest.vault.tsv"

# 3. Снимок полон: файл на каждую таблицу перечня; контрольные суммы файлов.
count="$(wc -l < "$OUT/manifest.tsv")"
files="$(find "$OUT/data" -name '*.copy' | wc -l)"
[ "$count" = "$files" ] && [ "$count" -gt 0 ] || fail "таблиц в перечне $count, файлов данных $files"
rows="$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$OUT/manifest.tsv")"
(cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
chmod -R go-rwx "$OUT"
echo "OK копия снята: таблиц — $count, строк — $rows, статус базы — $STATUS"
echo "Каталог: ${OUT#"$PWD"/}"
echo "Дальше — проверка восстановлением: bash migration/target/export-verify.sh ${OUT#"$PWD"/}"
