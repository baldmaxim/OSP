#!/usr/bin/env bash
# Проверка копии базы Яндекса восстановлением (migration/target/export.sh). Базу Яндекса не трогает:
# копия поднимается во временном PostgreSQL в Docker, после проверки контейнер удаляется.
#
#   bash migration/target/export-verify.sh migration/dumps/yandex-<время>
#
# Копия годна, если: контрольные суммы файлов совпадают; структура и данные восстановились без ошибок;
# в каждой таблице то же число строк и та же контрольная сумма, что были в базе в момент снимка;
# материализованные представления пересчитываются. В вывод — только имена таблиц и числа.
set -euo pipefail
DIR="${1:?укажите каталог копии: migration/dumps/yandex-<время>}"
DIR="$(cd "$DIR" && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../backup/lib.sh
source "$HERE/../backup/lib.sh"
for f in pre-data.sql post-data.sql manifest.tsv sequences.sql SHA256SUMS; do [ -f "$DIR/$f" ] || { echo "Нет $f — это не копия export.sh"; exit 1; }; done
(cd "$DIR" && sha256sum --quiet -c SHA256SUMS >/dev/null 2>&1) || { echo "КОПИЯ ПОВРЕЖДЕНА: контрольные суммы файлов не совпадают"; exit 1; }

TMP="$(mktemp -d)"
trap 'pg_stop; rm -rf "$TMP"' EXIT
echo "Временный PostgreSQL ($PG_IMAGE)…"
PG_INITDB_ARGS='-E UTF8 --locale-provider=icu --icu-locale=en-US' pg_start
step() { local what="$1"; shift; if ! "$@" >"$TMP/out" 2>"$TMP/err"; then echo "КОПИЯ НЕ ГОДНА: $what — $(grep -m 1 -E 'ERROR|FATAL' "$TMP/err" | sed -E 's/\([^)]*\)/(…)/g' | cut -c1-200)"; exit 1; fi; }
step "структура до данных" local_psql -f "$DIR/pre-data.sql"
{
  echo '\set ON_ERROR_STOP on'
  while IFS=$'\t' read -r table _; do echo "\\copy $table from '$DIR/data/$table.copy'"; done < "$DIR/manifest.tsv"
} > "$TMP/load.psql"
step "данные" local_psql -f "$TMP/load.psql"
step "счётчики" local_psql -f "$DIR/sequences.sql"
step "структура после данных" local_psql -f "$DIR/post-data.sql"
local_psql -At -c "select format('refresh materialized view %I.%I;', schemaname, matviewname) from pg_matviews" > "$TMP/refresh.sql"
step "пересчёт материализованных представлений" local_psql -f "$TMP/refresh.sql"

# Суперпользователю временной базы правила по строкам не мешают: считаем то же, что считал снимок.
local_psql -At -F $'\t' -c "
  select n.nspname || '.' || c.relname,
         (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text,
         (xpath('/row/h/text()', query_to_xml(format('select coalesce(md5(string_agg(h, '''' order by h)), ''-'') as h from (select md5(t::text) as h from %I.%I t) x', n.nspname, c.relname), false, true, '')))[1]::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r' and n.nspname in ('public', 'auth', 'osp_meta', 'osp_private', 'osp_vault', 'osp_auth')" | LC_ALL=C sort > "$TMP/restored.tsv"
LC_ALL=C sort "$DIR/manifest.tsv" > "$TMP/manifest.tsv"
if ! diff -q "$TMP/manifest.tsv" "$TMP/restored.tsv" >/dev/null; then
  echo "КОПИЯ НЕ ГОДНА: таблицы отличаются от снимка —"
  diff "$TMP/manifest.tsv" "$TMP/restored.tsv" | grep '^[<>]' | cut -f1 | sed 's/^[<>] //' | sort -u | head -20
  exit 1
fi
tables="$(wc -l < "$DIR/manifest.tsv")"
rows="$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$DIR/manifest.tsv")"
policies="$(local_psql -At -c "select count(*) from pg_policies")"
forced="$(local_psql -At -c "select count(*) from pg_class where relforcerowsecurity")"
: > "$DIR/.verified"
echo "КОПИЯ ГОДНА: таблиц $tables, строк $rows; число строк и контрольные суммы всех таблиц совпали со снимком;"
echo "политик $policies, таблиц с правилами на владельце $forced, ошибок восстановления нет."
