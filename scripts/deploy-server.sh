#!/usr/bin/env bash
# Выкладка нового портала ОСП (https://tender.su10.ru) на сервере corp — одной командой.
# Запускать на сервере от владельца каталога портала (corpsu), из клона репозитория:
#
#   cd /opt/portals/osp/src
#   bash scripts/deploy-server.sh --check        # только проверки, ничего не меняет
#   bash scripts/deploy-server.sh migrate        # миграции базы нового портала (migration/yandex), с вопросом
#   bash scripts/deploy-server.sh migrate --yes  # то же без вопроса
#   bash scripts/deploy-server.sh backend        # собрать и выложить API (сайт — из выложенного выпуска)
#   bash scripts/deploy-server.sh frontend       # собрать и выложить сайт (API — из выложенного выпуска)
#   bash scripts/deploy-server.sh both           # собрать и выложить API и сайт
#   bash scripts/deploy-server.sh status | rollback
#
# Если меняется и база: сначала migrate, потом backend или both (список шлюза — в образе API).
#
# На сервере работают соседние порталы — они не должны почувствовать ничего (deploy/docker/README.md):
#   • сборка — в своём сборщике buildx «osp-builder»: потолок памяти OSP_BUILD_MEMORY (1280m), одно ядро,
#     пониженный приоритет. Перед сборкой проверяется свободная память (потолок + 512 МБ) и диск (5 ГБ):
#     не хватает — отказ, ничего не начинается. После сборки сборщик останавливается;
#   • общих команд Docker нет: чистится только кэш своего сборщика, свои каталоги выпусков и копий;
#     свои образы старых выпусков убирает deploy.sh;
#   • выкладка — deploy/docker/deploy.sh install: проверка готовности, при отказе — прежний выпуск;
#     снимок соседей (neighbors.sh) до и сравнение после.
# Секреты на экран не выводятся. Окружение: OSP_HOME (/opt/portals/osp), OSP_BUILD_MEMORY (1280m),
# OSP_GIT_REMOTE (origin), OSP_GIT_BRANCH (main), SKIP_GIT_SYNC=1 — выложить то, что уже в клоне.
set -euo pipefail

# Скрипт лежит в клоне, который обновляет git sync: bash читает файл по ходу выполнения, поэтому работаем
# с копией. Если git sync привёз новую версию скрипта — продолжаем ею (без повторного sync).
if [ -z "${OSP_DEPLOY_SELF:-}" ]; then
  self="$(mktemp)"
  cp "$0" "$self"
  OSP_DEPLOY_SELF="$self" OSP_DEPLOY_SRC="$(cd "$(dirname "$0")/.." && pwd -P)" exec bash "$self" "$@"
fi
trap 'rm -f -- "$OSP_DEPLOY_SELF"' EXIT

readonly OSP_HOME="${OSP_HOME:-/opt/portals/osp}"
readonly SRC="$OSP_DEPLOY_SRC"
readonly BUILDER="osp-builder"
readonly BUILD_MEMORY="${OSP_BUILD_MEMORY:-1280m}"
readonly MEMINFO="${OSP_MEMINFO:-/proc/meminfo}"
readonly MIN_DISK_GB="${OSP_MIN_DISK_GB:-5}"
readonly REMOTE="${OSP_GIT_REMOTE:-origin}"
readonly BRANCH="${OSP_GIT_BRANCH:-main}"
readonly PROJECT="${OSP_PROJECT:-osp}"
readonly OUT="$OSP_HOME/build-out"
readonly DB_DIR="$OSP_HOME/secrets/db"
readonly WEB_ENV="$OSP_HOME/secrets/web-build.env"
readonly KEEP_BUILDS=2
readonly KEEP_BACKUPS=5

readonly C_RED='\033[0;31m' C_GREEN='\033[0;32m' C_YELLOW='\033[0;33m' C_BLUE='\033[0;34m' C_RESET='\033[0m'
log()  { printf '%b[deploy]%b %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf '%b[ ok ]%b  %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%b[warn]%b  %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
fail() { printf '%b[FAIL]%b  %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Использование: bash scripts/deploy-server.sh <режим>

  --check         только проверки, ничего не меняет
  migrate [--yes] миграции базы нового портала (migration/yandex); без --yes — с вопросом
  backend         собрать и выложить API, сайт — из выложенного выпуска
  frontend        собрать и выложить сайт, API — из выложенного выпуска
  both            собрать и выложить API и сайт
  status          что выложено и отвечает ли
  rollback        вернуть предыдущий выпуск

Если меняется и база: сначала migrate, потом backend или both.
EOF
}

mode_of() { stat -c '%a' "$1"; }
owner_only() { local m; m="$(mode_of "$1")"; [ "$m" = 600 ] || [ "$m" = 400 ]; }
to_mb() { # 1280m | 2g | 1536 → МБ
  case "$1" in
    *[gG]) echo $(( ${1%[gG]} * 1024 )) ;;
    *[mM]) echo "${1%[mM]}" ;;
    *) echo "$1" ;;
  esac
}

# ---------- проверки ----------
preflight() {
  log "проверки"
  [ "$(id -u)" != 0 ] || fail "запускайте от владельца каталога портала, не от root"
  [ -d "$OSP_HOME" ] || fail "нет каталога портала $OSP_HOME"
  [ "$(stat -c '%U' "$OSP_HOME")" = "$(id -un)" ] || fail "$OSP_HOME принадлежит не $(id -un) — запускайте от его владельца"
  [ "$SRC" = "$(cd "$OSP_HOME/src" 2>/dev/null && pwd -P)" ] || fail "скрипт запущен не из клона $OSP_HOME/src (сейчас $SRC)"
  [ -d "$SRC/.git" ] || fail "$SRC — не клон репозитория"
  [ -f "$OSP_HOME/server.env" ] || fail "портал на этом сервере не установлен: нет $OSP_HOME/server.env (deploy/docker/README.md, первая установка)"
  command -v docker >/dev/null || fail "нет docker"
  docker compose version >/dev/null 2>&1 || fail "нет docker compose"
  docker buildx version >/dev/null 2>&1 || fail "нет docker buildx"
  ok "каталог портала, клон, docker, compose, buildx — на месте ($(id -un))"
}

need_web_env() {
  [ -f "$WEB_ENV" ] || fail "нет $WEB_ENV (VITE_SUPABASE_URL=, VITE_SUPABASE_ANON_KEY=)"
  owner_only "$WEB_ENV" || fail "$WEB_ENV доступен не только владельцу: нужно chmod 600"
  ok "настройки сборки сайта: $WEB_ENV"
}

need_db_files() {
  local f
  for f in target.env target.env.pin root.crt; do [ -s "$DB_DIR/$f" ] || fail "нет $DB_DIR/$f"; done
  owner_only "$DB_DIR/target.env" || fail "$DB_DIR/target.env доступен не только владельцу: нужно chmod 600"
  ok "подключение к базе нового портала: $DB_DIR (отпечаток базы закреплён)"
}

# Память и диск — до начала сборки; не хватает — ничего не начинаем.
resource_gate() {
  local avail_mb need_mb disk_gb root
  avail_mb="$(awk '/^MemAvailable:/ { print int($2 / 1024) }' "$MEMINFO")"
  need_mb=$(( $(to_mb "$BUILD_MEMORY") + 512 ))
  [ -n "$avail_mb" ] || fail "не прочитана свободная память ($MEMINFO)"
  if [ "$avail_mb" -lt "$need_mb" ]; then
    fail "мало свободной памяти: ${avail_mb} МБ, для сборки нужно ${need_mb} МБ — сейчас она нужна соседним порталам; повторите позже"
  fi
  root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)"
  [ -e "$root" ] || root=/
  disk_gb="$(df -Pk "$root" | awk 'NR == 2 { print int($4 / 1048576) }')"
  [ "$disk_gb" -ge "$MIN_DISK_GB" ] || fail "мало места на диске Docker: ${disk_gb} ГБ, нужно ${MIN_DISK_GB} ГБ"
  ok "память: доступно ${avail_mb} МБ (нужно ${need_mb}); диск: ${disk_gb} ГБ"
}

# ---------- git ----------
git_sync() {
  if [ "${SKIP_GIT_SYNC:-0}" = 1 ]; then
    warn "SKIP_GIT_SYNC=1 — беру то, что уже в клоне: $(git -C "$SRC" rev-parse --short=12 HEAD)"
    return 0
  fi
  log "git sync $REMOTE/$BRANCH"
  git -C "$SRC" fetch -q "$REMOTE" "$BRANCH" --prune
  git -C "$SRC" checkout -q -f -B "$BRANCH" "$REMOTE/$BRANCH"
  git -C "$SRC" reset -q --hard "$REMOTE/$BRANCH"
  git -C "$SRC" clean -q -fd
  ok "HEAD: $(git -C "$SRC" rev-parse --short=12 HEAD) — $(git -C "$SRC" log -1 --pretty=%s | cut -c1-100)"
  if ! cmp -s "$OSP_DEPLOY_SELF" "$SRC/scripts/deploy-server.sh"; then
    log "скрипт выкладки обновился — продолжаю новой версией"
    rm -f -- "$OSP_DEPLOY_SELF"
    SKIP_GIT_SYNC=1 OSP_DEPLOY_SELF= exec bash "$SRC/scripts/deploy-server.sh" "$@"
  fi
}

# ---------- свой сборщик ----------
ensure_builder() {
  local cpu opts
  cpu=$(( $(nproc) - 1 ))
  opts="memory=$BUILD_MEMORY,memory-swap=$BUILD_MEMORY,cpuset-cpus=$cpu,cpu-shares=256,default-load=true"
  if docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
    if docker buildx inspect "$BUILDER" 2>/dev/null | grep -q "memory=\"$BUILD_MEMORY\""; then
      ok "сборщик $BUILDER: потолок памяти $BUILD_MEMORY, ядро $cpu"
      return 0
    fi
    log "у сборщика $BUILDER другой потолок — пересоздаю (только свой сборщик)"
    docker buildx rm "$BUILDER" >/dev/null
  fi
  log "создаю свой сборщик $BUILDER: потолок памяти $BUILD_MEMORY, ядро $cpu, пониженный приоритет"
  docker buildx create --name "$BUILDER" --driver docker-container --driver-opt "$opts" >/dev/null
  ok "сборщик $BUILDER создан"
}

# Кэш своего сборщика — не больше 3 ГБ; сам сборщик — остановить: память нужна соседям.
release_builder() {
  docker buildx prune --builder "$BUILDER" --force --max-used-space 3gb >/dev/null 2>&1 \
    || warn "кэш сборщика не почищен — не критично"
  docker buildx stop "$BUILDER" >/dev/null 2>&1 || true
  ok "сборщик $BUILDER остановлен, его кэш — не больше 3 ГБ"
}

# ---------- сборка и выкладка ----------
build_release() { # build_release both|api|web
  local what="$1" args=(--out "$OUT" --no-save) rc=0
  if [ "$what" != both ]; then
    [ -f "$OSP_HOME/current/release.env" ] || fail "портал ещё не выложен — первый раз: bash scripts/deploy-server.sh both"
    args+=(--only "$what" --reuse "$OSP_HOME/current/release.env")
  fi
  resource_gate
  ensure_builder
  log "сборка выпуска ($([ "$what" = both ] && echo 'API и сайт' || echo "только $what"))"
  mkdir -p "$OUT"
  OSP_BUILDER="$BUILDER" OSP_WEB_BUILD_ENV="$WEB_ENV" bash "$SRC/deploy/docker/build.sh" "${args[@]}" || rc=$?
  release_builder
  [ "$rc" = 0 ] || fail "сборка не удалась (код $rc) — на сервере ничего не изменилось"
  REL="$OUT/osp-release-$(git -C "$SRC" rev-parse --short=12 HEAD)"
  [ -f "$REL/MANIFEST" ] || fail "выпуск не найден: $REL"
}

install_release() {
  log "снимок соседей по серверу"
  bash "$REL/neighbors.sh" --save
  log "выкладка $(basename "$REL")"
  bash "$REL/deploy.sh" install "$REL" || fail "выпуск не выложен — работает прежний (подробности выше)"
  log "сравнение соседей"
  bash "$REL/neighbors.sh" --compare || fail "соседи по серверу изменились — разобраться до любых дальнейших шагов"
  cleanup_builds
}

cleanup_builds() {
  local cur n=0 d
  cur="$(basename "$(readlink "$OSP_HOME/current" 2>/dev/null || true)")"
  while read -r d; do
    n=$((n + 1))
    [[ "$d" =~ ^osp-release-[0-9a-f]{12}$ ]] || continue
    if [ "$n" -gt "$KEEP_BUILDS" ] && [ "$d" != "osp-release-$cur" ]; then rm -rf -- "${OUT:?}/$d"; fi
  done < <(find "$OUT" -mindepth 1 -maxdepth 1 -type d -name 'osp-release-*' -printf '%T@ %f\n' | sort -rn | awk '{ print $2 }')
}

# ---------- миграции ----------
tools_image() {
  echo "osp-tools:$(sha256sum "$SRC/deploy/docker/tools.Dockerfile" | cut -c1-12)"
}

ensure_tools() {
  local img; img="$(tools_image)"
  if docker image inspect "$img" >/dev/null 2>&1; then ok "образ инструментов базы: $img"; return 0; fi
  resource_gate
  ensure_builder
  log "сборка образа инструментов базы $img"
  local rc=0
  docker buildx build --builder "$BUILDER" --load -q -t "$img" -f "$SRC/deploy/docker/tools.Dockerfile" "$SRC/deploy/docker" >/dev/null || rc=$?
  release_builder
  [ "$rc" = 0 ] || fail "образ инструментов не собран"
  ok "образ инструментов базы: $img"
}

# migration/target/migrate.sh в контейнере инструментов: клон и подключение — только на чтение.
run_tools() {
  mkdir -p "$OSP_HOME/reports/db" "$OSP_HOME/backups"
  chmod 700 "$OSP_HOME/reports" "$OSP_HOME/reports/db" "$OSP_HOME/backups"
  local net=()
  [ -z "${OSP_TOOLS_NETWORK:-}" ] || net=(--network "$OSP_TOOLS_NETWORK")
  docker run --rm "${net[@]}" --user "$(id -u):$(id -g)" --memory 512m --cpus 1 \
    -e HOME=/tmp -e PROBE_REPORT_DIR=/reports -e BACKUP_OUT_DIR=/backups \
    -e OSP_TOOL_COMMIT="$(git -C "$SRC" rev-parse HEAD)" \
    -v "$SRC:/src:ro" -v "$DB_DIR:/db:ro" -v "$OSP_HOME/reports/db:/reports" -v "$OSP_HOME/backups:/backups" \
    -w /src "$(tools_image)" bash migration/target/migrate.sh /db/target.env "$@"
}

cleanup_backups() {
  local n=0 d
  while read -r d; do
    n=$((n + 1))
    [[ "$d" =~ ^yandex-[0-9]{8}-[0-9]{6}$ ]] || continue
    if [ "$n" -gt "$KEEP_BACKUPS" ]; then rm -rf -- "${OSP_HOME:?}/backups/$d"; fi
  done < <(find "$OSP_HOME/backups" -mindepth 1 -maxdepth 1 -type d -name 'yandex-*' -printf '%f\n' | sort -r)
}

do_migrate() {
  local yes="$1" plan rc=0
  need_db_files
  ensure_tools
  log "что нового в migration/yandex (только чтение)"
  plan="$(run_tools --dry-run)" || { printf '%s\n' "$plan"; fail "проверка миграций не прошла — база не менялась"; }
  printf '%s\n' "$plan" | grep -v '^Отчёт сохранён'
  if printf '%s\n' "$plan" | grep -q 'новых миграций нет'; then
    ok "новых миграций нет — база не менялась"
    return 0
  fi
  if [ "$yes" != 1 ]; then
    [ -t 0 ] || fail "нет терминала для вопроса — запустите: bash scripts/deploy-server.sh migrate --yes"
    local answer
    read -r -p "Применить эти миграции в базу нового портала? Перед этим снимается копия базы. [y/N] " answer
    [[ "$answer" =~ ^[yYдД]$ ]] || { warn "отменено — база не менялась"; return 0; }
  fi
  log "миграции"
  run_tools --yes || rc=$?
  # Структуру PostgREST перечитывает только по сигналу; безвредно, даже если ничего не применилось.
  docker compose -p "$PROJECT" kill -s SIGUSR1 osp-postgrest >/dev/null 2>&1 \
    && ok "PostgREST перечитал структуру базы" || warn "PostgREST не получил сигнал — портал не выложен?"
  cleanup_backups
  [ "$rc" = 0 ] || fail "миграции остановлены (код $rc): подробности выше; отчёт — $OSP_HOME/reports/db"
  bash "$OSP_HOME/deploy.sh" status || warn "проверка готовности не прошла — посмотрите вывод выше"
}

# ---------- --check ----------
reachable() { timeout 8 bash -c "exec 3<>/dev/tcp/$1/443" 2>/dev/null; }
do_check() {
  local avail_mb need_mb
  need_web_env
  need_db_files
  avail_mb="$(awk '/^MemAvailable:/ { print int($2 / 1024) }' "$MEMINFO")"
  need_mb=$(( $(to_mb "$BUILD_MEMORY") + 512 ))
  if [ "$avail_mb" -ge "$need_mb" ]; then ok "память: доступно ${avail_mb} МБ (для сборки нужно ${need_mb})"
  else warn "память: доступно ${avail_mb} МБ — для сборки нужно ${need_mb}, сборка сейчас откажет"; fi
  timeout 20 git -C "$SRC" ls-remote -q "$REMOTE" "$BRANCH" >/dev/null 2>&1 && ok "репозиторий доступен ($REMOTE)" || warn "репозиторий недоступен — git sync не пройдёт"
  reachable registry-1.docker.io && ok "Docker Hub доступен (базовые образы сборки)" || warn "Docker Hub недоступен — сборка образов не пройдёт"
  if docker image inspect "$(tools_image)" >/dev/null 2>&1; then
    run_tools --dry-run | grep -v '^Отчёт сохранён' || warn "проверка базы не прошла"
  else
    warn "образ инструментов базы ещё не собран — соберётся при первом migrate"
  fi
  bash "$OSP_HOME/deploy.sh" status || warn "портал не отвечает или не выложен"
  ok "--check: ничего не изменено"
}

summary() {
  echo
  ok "готово — выпуск $(git -C "$SRC" rev-parse --short=12 HEAD)"
  echo "  Портал: https://tender.su10.ru/"
  echo "  Состояние: bash $OSP_HOME/deploy.sh status"
}

main() {
  local scope="${1:-}"
  case "$scope" in
    --check)              preflight; do_check ;;
    migrate)
      local yes=0
      [ "${2:-}" = --yes ] && yes=1
      [ $# -le 1 ] || [ "$yes" = 1 ] || { usage; fail "неизвестный ключ: $2"; }
      preflight
      exec 9>"$OSP_HOME/.deploy-server.lock"; flock -n 9 || fail "уже идёт другая выкладка или миграция"
      git_sync "$@"; do_migrate "$yes" ;;
    backend | frontend | both)
      preflight; need_web_env
      exec 9>"$OSP_HOME/.deploy-server.lock"; flock -n 9 || fail "уже идёт другая выкладка или миграция"
      git_sync "$@"
      case "$scope" in backend) build_release api ;; frontend) build_release web ;; both) build_release both ;; esac
      install_release; summary ;;
    status)               preflight; bash "$OSP_HOME/deploy.sh" status ;;
    rollback)             preflight; bash "$OSP_HOME/deploy.sh" rollback ;;
    -h | --help)          usage ;;
    "")                   usage; exit 1 ;;
    *)                    usage; fail "неизвестный режим: $scope" ;;
  esac
}

main "$@"
