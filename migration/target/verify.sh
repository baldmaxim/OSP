#!/usr/bin/env bash
# Сверка загруженной базы с копией: загружено ровно то, что было. ТОЛЬКО ЧТЕНИЕ выданной базы.
# Запускать на удалённой машине из корня репозитория, после load.sh:
#
#   bash migration/target/verify.sh <файл подключения> <копия.dump>
#
# Эталон — та же копия, восстановленная во временный PostgreSQL в Docker со всеми ролями Supabase
# (как в migration/backup/verify.sh). На эталоне и на загруженной базе выполняется один и тот же
# набор запросов (sql/verify-facts.sql); ответы обязаны совпасть строка в строку:
#   • число строк и контрольная сумма каждой таблицы и материализованного представления (у представления с
#     уникальным индексом — по колонкам индекса: его строки строятся заново из сверенных таблиц, а выбор
#     среди равных определение может не задавать; в app_settings — без отметки пересчёта реестра);
#   • счётчики номеров; колонки, ограничения, индексы, триггеры, функции, представления, типы;
#   • политики (команда, условия, роли) и выданные права: роль приложения в загруженной базе против
#     роли authenticated в эталоне. Политики только для anon / service_role не переносятся и в сверке
#     не участвуют.
# Если загрузка была без прав (load.sh --without-rights), вместо сверки политик и прав проверяется, что
# база закрыта для обычных учёток кластера (sql/verify-closed.sql): политик нет, выдач не владельцу нет,
# функции и типы «всем» не открыты.
# Дополнительно: число строк против подсчёта на проде в момент снятия копии (.counts-after.tsv),
# часовой пояс базы и порядок сортировки кириллицы.
# В вывод и отчёт (migration/target/reports/verify-<время>.txt) идут только имена объектов и числа.
# Выход: 0 — расхождений нет; 1 — ошибка запуска; 2 — нет подключения; 4 — есть расхождения.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
REPORT_DIR="${PROBE_REPORT_DIR:-$HERE/reports}"
# shellcheck source=lib/conn.sh
. "$HERE/lib/conn.sh"
# shellcheck source=../backup/lib.sh
. "$ROOT/migration/backup/lib.sh"

ENV_FILE="${1:-}"
DUMP="${2:-}"
COVERS_JOURNAL=""
if [ "${3:-}" = --covers ] && [ -n "${4:-}" ] && [ $# -eq 4 ]; then COVERS_JOURNAL="$4"
elif [ $# -ne 2 ]; then DUMP=""; fi
if [ -z "$ENV_FILE" ] || [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "Использование: bash migration/target/verify.sh <файл подключения> <копия.dump> [--covers <журнал covers-copy>]" >&2
  exit 1
fi
if [ -n "$COVERS_JOURNAL" ] && [ ! -f "$COVERS_JOURNAL" ]; then
  echo "Нет журнала копирования обложек: $COVERS_JOURNAL" >&2
  exit 1
fi
for bin in psql pg_restore docker sha256sum; do
  command -v "$bin" >/dev/null || { echo "Нужен $bin" >&2; exit 1; }
done
BASE="${DUMP%.dump}"
DROP_ROLES='anon,service_role'
# Порядок сортировки, как в Supabase (ICU en-US): хэш упорядоченного набора строк ниже.
SORT_SAMPLE="'ёж','Ель','еж','Яма','а','Б','б','ООО «Ромашка»','ооо ромашка','1','10','2','_','-','Zeta','alpha','Эхо','юг'"
SORT_EXPECTED='d858d66a2f87e4f4ade570ca7f28b5f9'

target_conn "$ENV_FILE" || exit 1
export PGAPPNAME=osp-verify-readonly

WORK="$(mktemp -d)"
chmod 700 "$WORK"
REPORT=""
cleanup() {
  pg_stop
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then rm -rf -- "$WORK"; fi
  unset PGPASSWORD
}
trap cleanup EXIT

say() {
  REPORT+="$1"$'\n'
  printf '%s\n' "$1"
}
save_report() {
  mkdir -p "$REPORT_DIR"
  chmod 700 "$REPORT_DIR"
  local file
  file="$REPORT_DIR/verify-$(date -u +%Y%m%d-%H%M%S).txt"
  (umask 077; printf '%s' "$REPORT" > "$file")
  echo "Отчёт сохранён: ${file#"$PWD"/}"
}
target_psql() { psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }

say "Сверка загруженной базы с копией $(basename "$DUMP"). $(date -u '+%Y-%m-%d %H:%M') UTC"

# 1. Что загружено: отметка загрузчика должна указывать на эту же копию.
SHA="$(sha256sum "$DUMP" | cut -d' ' -f1)"
if ! mark="$(target_psql -F $'\t' -c "select status, source_sha256, rights, coalesce(runtime_role, '-'), (finished_at is not null) from osp_meta.load_log order by id desc limit 1" 2>"$WORK/err")"; then
  say "FAIL нет подключения или в базе нет отметки загрузки (osp_meta.load_log): $(head -n 1 "$WORK/err" | target_mask | cut -c1-200)"
  save_report
  exit 2
fi
IFS=$'\t' read -r STATUS LOADED_SHA RIGHTS RUNTIME_ROLE FINISHED <<< "$mark"
if [ "$LOADED_SHA" != "$SHA" ] || [ "$FINISHED" != t ]; then
  say "FAIL в базу загружена другая копия или загрузка не завершена — сверять не с чем"
  save_report
  exit 4
fi
if [ "$RIGHTS" = single ]; then
  say "FAIL права под одну учётку уже применены (rights.sh): структура намеренно отличается от копии."
  say "Сверка данных и структуры делается до rights.sh; права проверяет bash migration/target/rights.sh <файл подключения> --check"
  save_report
  exit 4
fi
if [ "$RIGHTS" = loaded ]; then
  WITH_RIGHTS=1
  say "ИНФО отметка загрузки: статус $STATUS, копия та же (sha256 ${SHA:0:12}…), роль приложения $RUNTIME_ROLE"
else
  WITH_RIGHTS=0
  say "ИНФО отметка загрузки: статус $STATUS, копия та же (sha256 ${SHA:0:12}…), без прав"
fi

# 2. Эталон: та же копия во временном PostgreSQL, с правами и с правилами сортировки прода (ICU en-US):
#    от сортировки зависит содержимое материализованных представлений.
say "ИНФО эталон: восстановление копии во временный PostgreSQL ($PG_IMAGE)…"
PG_INITDB_ARGS='-E UTF8 --locale-provider=icu --icu-locale=en-US' pg_start
RESTORE_PRIVILEGES=1 restore_dump "$DUMP" "$WORK/restore.log"
if [ "$RESTORE_ERRORS" != 0 ]; then
  say "FAIL эталон восстановился с ошибками ($RESTORE_ERRORS) — сначала bash migration/backup/verify.sh"
  save_report
  exit 1
fi

# 2а. Адреса обложек: загрузка с --covers меняла objects.cover_image_url — ту же замену получает эталон
#     (из того же журнала), и перечень замен в базе обязан совпасть с эталонным.
if ! has_moves="$(target_psql -c "select to_regclass('osp_meta.cover_moves') is not null" 2>"$WORK/err")"; then
  say "FAIL нет подключения: $(head -n 1 "$WORK/err" | target_mask | cut -c1-200)"; save_report; exit 2
fi
if [ "$has_moves" = t ] && [ -z "$COVERS_JOURNAL" ]; then
  say "FAIL загрузка меняла адреса обложек: сверка — с тем же журналом, --covers <журнал covers-copy>"; save_report; exit 1
fi
if [ "$has_moves" != t ] && [ -n "$COVERS_JOURNAL" ]; then
  say "FAIL указан журнал обложек, а загрузка адреса не меняла (load.sh без --covers)"; save_report; exit 4
fi
if [ -n "$COVERS_JOURNAL" ]; then
  if ! node "$HERE/lib/extras.mjs" covers-sql "$COVERS_JOURNAL" "$BASE.covers.csv" "$WORK/covers.json" > "$WORK/covers-data.sql" 2>"$WORK/err"; then
    say "FAIL журнал обложек не принят: $(head -n 1 "$WORK/err" | cut -c1-200)"; save_report; exit 1
  fi
  if ! local_psql -c 'CREATE SCHEMA IF NOT EXISTS osp_meta' -v status="$STATUS" -v covers_data_file="$WORK/covers-data.sql" \
       -f "$HERE/sql/load-covers.sql" >/dev/null 2>"$WORK/err"; then
    say "FAIL замена адресов обложек на эталоне не прошла: $(grep -m 1 -E 'ERROR|FATAL|error' "$WORK/err" | sed -E 's/"[^"]*"/"…"/g' | cut -c1-200)"
    save_report; exit 4
  fi
  moves_sql="select name, sha256, old_url, new_url, objects_updated from osp_meta.cover_moves order by name"
  if [ "$(local_psql -At -c "$moves_sql" | sha256sum)" = "$(target_psql -c "$moves_sql" 2>/dev/null | sha256sum)" ]; then
    say "OK адреса обложек: замены в базе — ровно по журналу ($(target_psql -c 'select count(*) from osp_meta.cover_moves') файлов, адресов $(target_psql -c 'select coalesce(sum(objects_updated), 0) from osp_meta.cover_moves'))"
  else
    problems_pre=1
    say "FAIL адреса обложек: замены в базе не совпадают с журналом"
  fi
fi

# 2б. Учётные записи (load.sh --auth): выгрузка из базы побайтно равна выгрузке копии —
#     те же колонки, порядок и формат (UTC, ISO), что в migration/backup/extras.sql.
if ! has_vault="$(target_psql -c "select to_regnamespace('osp_vault') is not null" 2>"$WORK/err")"; then
  say "FAIL нет подключения: $(head -n 1 "$WORK/err" | target_mask | cut -c1-200)"; save_report; exit 2
fi
if [ "$has_vault" = t ]; then
  vault_ok=1
  for pair in "users:auth-users:id:учётные записи" "identities:auth-identities:user_id, provider, id:способы входа"; do
    IFS=: read -r table suffix order title <<< "$pair"
    file="$BASE.$suffix.csv"
    if [ ! -f "$file" ]; then vault_ok=0; say "FAIL $title: нет выгрузки копии $(basename "$file")"; continue; fi
    cols="$(head -n 1 "$file")"
    [[ "$cols" =~ ^[a-z_]+(,[a-z_]+)*$ ]] || { vault_ok=0; say "FAIL $title: заголовок выгрузки не похож на список колонок"; continue; }
    got="$(target_psql 2>"$WORK/err" <<SQL | sha256sum | cut -d' ' -f1
BEGIN TRANSACTION READ ONLY;
SELECT pg_catalog.set_config('application_name', 'osp:vault', true), pg_catalog.set_config('TimeZone', 'UTC', true),
       pg_catalog.set_config('DateStyle', 'ISO, YMD', true), pg_catalog.set_config('IntervalStyle', 'postgres', true),
       pg_catalog.set_config('extra_float_digits', '1', true) \gset ignored_
COPY (SELECT ${cols//,/, } FROM osp_vault.$table ORDER BY $order) TO STDOUT WITH (FORMAT csv, HEADER true);
COMMIT;
SQL
)"
    if [ "$got" = "$(sha256sum "$file" | cut -d' ' -f1)" ]; then
      say "OK $title: в базе ровно выгрузка копии — $(( $(grep -c '' "$file") - 1 )) строк, побайтно"
    else
      vault_ok=0; say "FAIL $title: в базе не то, что в выгрузке копии"
    fi
  done
  [ "$vault_ok" = 1 ] || problems_pre=1
elif [ "$STATUS" = final ]; then
  problems_pre=1
  say "FAIL окончательный перенос без учётных записей Supabase Auth (osp_vault нет)"
else
  say "ИНФО учётные записи Supabase Auth не загружались (load.sh без --auth)"
fi

# 3. Факты с обеих сторон.
if ! local_psql -At -v with_rights="$WITH_RIGHTS" -v acl_role=authenticated -v drop_roles="$DROP_ROLES" -f "$HERE/sql/verify-facts.sql" > "$WORK/reference.raw" 2>"$WORK/err"; then
  say "FAIL сверка на эталоне прервана: $(grep -m 1 -E 'ERROR|FATAL|error' "$WORK/err" | sed -E 's/"[^"]*"/"…"/g' | cut -c1-200)"
  save_report
  exit 1
fi
LC_ALL=C sort "$WORK/reference.raw" > "$WORK/reference.tsv"
if ! target_psql -v with_rights="$WITH_RIGHTS" -v acl_role="$RUNTIME_ROLE" -v drop_roles="$DROP_ROLES" -f "$HERE/sql/verify-facts.sql" 2>"$WORK/err" > "$WORK/target.raw"; then
  say "FAIL сверка на загруженной базе прервана: $(grep -m 1 -E 'ERROR|FATAL|error' "$WORK/err" | sed -E 's/"[^"]*"/"…"/g' | target_mask | cut -c1-200)"
  save_report
  exit 2
fi
LC_ALL=C sort "$WORK/target.raw" > "$WORK/target.tsv"

# Ключи, у которых значение отличается или которых нет на одной из сторон (awk, не comm: в uutils он ненадёжен).
diff_keys_of() {
  awk -F'\t' -v k="$1" '
    NR == FNR { if ($1 == k) ref[$2] = $3; next }
    $1 == k { tgt[$2] = $3 }
    END {
      for (x in ref) if (!(x in tgt) || tgt[x] != ref[x]) print x
      for (x in tgt) if (!(x in ref)) print x
    }' "$WORK/reference.tsv" "$WORK/target.tsv" | LC_ALL=C sort -u
}
KINDS="$(printf '%s\n' \
  'rows:число строк по таблицам' 'sum:контрольные суммы данных' 'seq:счётчики номеров' 'col:колонки' \
  'con:ограничения' 'idx:индексы' 'trg:триггеры' 'fn:функции' 'view:представления' 'type:типы' \
  'rls:защита строк на таблицах')"
if [ "$WITH_RIGHTS" = 1 ]; then
  KINDS+=$'\npolicy:политики\ngrant:выданные права'
fi
problems="${problems_pre:-0}"
while IFS= read -r pair; do
  kind="${pair%%:*}"
  title="${pair#*:}"
  ref_n="$(grep -c "^$kind	" "$WORK/reference.tsv" || true)"
  tgt_n="$(grep -c "^$kind	" "$WORK/target.tsv" || true)"
  diff_keys="$(diff_keys_of "$kind")"
  if [ -z "$diff_keys" ] && [ "$ref_n" = "$tgt_n" ]; then
    say "OK $title: $tgt_n — совпадают"
  else
    n="$(printf '%s\n' "$diff_keys" | grep -c . || true)"
    problems=$((problems + 1))
    say "FAIL $title: расхождений — $n (в эталоне $ref_n, в базе $tgt_n): $(printf '%s\n' "$diff_keys" | head -n 8 | tr '\n' ' ')"
  fi
done <<< "$KINDS"

# 3а. Загрузка без прав: политики и выдачи не сверяются — вместо этого база обязана быть закрытой.
if [ "$WITH_RIGHTS" = 0 ]; then
  say "ВНИМАНИЕ политики и выданные права не сверялись: загрузка была без прав"
  if closed="$(target_psql -F $'\t' -f "$HERE/sql/verify-closed.sql" 2>"$WORK/err")"; then
    IFS=$'\t' read -r c_pol c_rel c_col c_fn c_type c_sch c_def <<< "$(printf '%s\n' "$closed" | grep -v '^info' | head -n 1)"
    IFS=$'\t' read -r _ c_can c_sess <<< "$(printf '%s\n' "$closed" | grep '^info' | head -n 1)"
    if [ "$c_pol:$c_rel:$c_col:$c_fn:$c_type:$c_sch:$c_def" = "0:0:0:0:0:0:0" ]; then
      say "OK база закрыта для обычных учёток кластера: политик 0, выдач не владельцу 0, функций и типов, открытых «всем», 0"
    else
      problems=$((problems + 1))
      say "FAIL база не закрыта: политик — $c_pol; выдач на таблицы и счётчики не владельцу — $c_rel, на колонки — $c_col; функций, открытых не только владельцу, — $c_fn; типов, открытых «всем», — $c_type; выдач на служебные схемы — $c_sch; нет запрета по умолчанию для будущих функций или типов — $c_def"
    fi
    say "ИНФО подключиться к базе могут ещё обычных учёток: ${c_can:-?} (имена и тексты функций им видны, данные — нет); их сеансов сейчас: ${c_sess:-?}"
  else
    problems=$((problems + 1))
    say "FAIL проверка «база закрыта» прервана: $(grep -m 1 -E 'ERROR|FATAL|error' "$WORK/err" | sed -E 's/"[^"]*"/"…"/g' | target_mask | cut -c1-200)"
  fi
fi

# 4. Число строк против прода: backup.sh считает строки до копии и сразу после неё.
#    Репетиция: число в базе — между «до» и «после» (во время копии люди работали — как в
#    migration/backup/verify.sh). Настоящий перенос (final): запись остановлена, поэтому «до» = «после» =
#    в базе, иначе отказ.
if [ -f "$BASE.counts-before.tsv" ] && [ -f "$BASE.counts-after.tsv" ]; then
  prod="$(awk -F'\t' -v final="$([ "$STATUS" = final ] && echo 1 || echo 0)" '
    FILENAME == ARGV[1] { before[$1] = $2 + 0; order[++n] = $1; next }
    FILENAME == ARGV[2] { after[$1] = $2 + 0; next }
    $1 == "rows" { got[$2] = $3 + 0 }
    END {
      for (i = 1; i <= n; i++) {
        t = order[i]; b = before[t]; a = (t in after) ? after[t] : b
        lo = (b < a) ? b : a; hi = (b < a) ? a : b
        if (!(t in got)) { missing = missing " " t; continue }
        if (b != a) moved++
        if (final ? (got[t] != b || b != a) : (got[t] < lo || got[t] > hi)) bad = bad " " t
      }
      printf "%d\t%d\t%s\t%s\n", n, moved, bad, missing
    }' "$BASE.counts-before.tsv" "$BASE.counts-after.tsv" "$WORK/target.tsv")"
  IFS=$'\t' read -r prod_n prod_moved prod_bad prod_missing <<< "$prod"
  if [ -z "$prod_bad" ] && [ -z "$prod_missing" ]; then
    if [ "$prod_moved" = 0 ]; then
      say "OK число строк равно подсчёту на проде до и после копии ($prod_n таблиц)"
    else
      say "OK число строк — в пределах подсчёта на проде до и после копии ($prod_n таблиц; во время копии менялись $prod_moved)"
    fi
  else
    problems=$((problems + 1))
    if [ "$STATUS" = final ]; then
      say "FAIL настоящий перенос: число строк должно быть равно проду и до, и после копии — запись не была остановлена или строки потеряны:${prod_bad:- —}; нет таблиц:${prod_missing:- —}"
    else
      say "FAIL число строк вне подсчёта на проде до и после копии:${prod_bad:- —}; нет таблиц:${prod_missing:- —}"
    fi
  fi
else
  problems=$((problems + 1))
  say "FAIL нет файлов подсчёта на проде ($(basename "$BASE").counts-before/after.tsv) — копия снята не через backup.sh"
fi

# 5. Настройки базы. Новый сеанс: настройка базы действует с подключения.
tz="$(target_psql -c 'show timezone' 2>/dev/null || true)"
if [ "$tz" = UTC ] || [ "$tz" = Etc/UTC ]; then
  say "OK часовой пояс базы — UTC, как в Supabase"
else
  problems=$((problems + 1))
  say "FAIL часовой пояс новых подключений — ${tz:-не прочитан}, нужен UTC"
fi
sort_md5="$(target_psql -c "select md5(string_agg(x, '|' order by x)) from unnest(array[$SORT_SAMPLE]) x" 2>/dev/null || true)"
if [ "$sort_md5" = "$SORT_EXPECTED" ]; then
  say "OK порядок сортировки кириллицы — как в Supabase (ICU en-US)"
else
  problems=$((problems + 1))
  say "FAIL порядок сортировки строк отличается от Supabase (ICU en-US)"
fi

if [ "$problems" = 0 ] && [ "$WITH_RIGHTS" = 0 ]; then
  say "РАСХОЖДЕНИЙ НЕТ: данные и структура — ровно как в копии; права не загружались, база закрыта."
  save_report
  exit 0
fi
if [ "$problems" = 0 ]; then
  say "РАСХОЖДЕНИЙ НЕТ: в базе ровно то, что в копии."
  save_report
  exit 0
fi
say "ЕСТЬ РАСХОЖДЕНИЯ: $problems. Базу в работу не пускать."
save_report
exit 4
