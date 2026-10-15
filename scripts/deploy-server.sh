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
# Свой вход tender.su10.ru (учётки и пароли в базе Яндекса; migration/CUTOVER.md, «Свой вход tender.su10.ru»):
#   bash scripts/deploy-server.sh auth-key-init              # ключ шифрования паролей (один раз, значение не выводится)
#   bash scripts/deploy-server.sh edge-token-init            # жетон адреса клиента для общего nginx (один раз)
#   bash scripts/deploy-server.sh transfer-key-init          # ключ переноса паролей из Supabase; печатает открытый ключ
#   bash scripts/deploy-server.sh accounts-sync --users <файл> --credentials <файл> [--manifest <файл>] [--restore <uuid>] [--yes]
#   bash scripts/deploy-server.sh accounts-check             # готов ли свой вход (только чтение)
#   bash scripts/deploy-server.sh auth-mode supabase|both|own  # переключить вход без сборки; не прошло — прежний
#   bash scripts/deploy-server.sh transfer-key-destroy       # после переноса: удалить ключ переноса и файлы выгрузок
#
# Если меняется и база: сначала migrate, потом backend или both (список шлюза — в образе API).
#
# На сервере работают соседние порталы — они не должны почувствовать ничего (deploy/docker/README.md):
#   • сборка — в своём сборщике buildx «osp-builder»: потолок памяти OSP_BUILD_MEMORY (1280m), одно ядро,
#     пониженный приоритет. Перед сборкой проверяется свободная память (потолок + 512 МБ) и диск (5 ГБ):
#     не хватает — отказ, ничего не начинается. После сборки сборщик останавливается;
#   • buildx — свой, закреплённой версии (deploy/docker/buildx.pin), в каталоге портала: подключается только
#     к нашим командам через DOCKER_CONFIG. В систему и в общий ~/.docker не ставится — сборки соседних
#     порталов под той же учёткой не меняются. Ставится сам при первой сборке: файл
#     $OSP_HOME/docker/buildx-<версия>.linux-<арх>, если его положили заранее, иначе скачивание с GitHub;
#     в обоих случаях — сверка контрольной суммы;
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
readonly BX_HOME="$OSP_HOME/docker"
readonly API_ENV="$OSP_HOME/secrets/osp-api.env"
readonly TRANSFER_KEY="$OSP_HOME/secrets/accounts-transfer.key"
readonly ACCOUNTS_IN="$OSP_HOME/accounts/in"

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

  Свой вход tender.su10.ru:
  auth-key-init         ключ шифрования паролей в secrets/osp-api.env (один раз)
  edge-token-init       жетон адреса клиента (secrets/osp-web.env); затем запись общего nginx и frontend
  transfer-key-init     ключ переноса паролей из Supabase; печатает открытый ключ
  accounts-sync --users <файл> --credentials <файл> [--manifest <файл>] [--restore <uuid>] [--yes]
                        перенос учёток и паролей (файлы — в $ACCOUNTS_IN); без --yes — с вопросом
  accounts-check        готов ли свой вход (только чтение)
  auth-mode <режим>     supabase | both | own — без сборки; не прошло — возвращается прежний
  transfer-key-destroy  удалить ключ переноса и файлы выгрузок

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
  [ -f "$SRC/deploy/docker/buildx.pin" ] || fail "нет $SRC/deploy/docker/buildx.pin"
  ok "каталог портала, клон, docker, compose — на месте ($(id -un))"
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

# ---------- свой buildx и свой сборщик ----------
pin() { grep -m 1 -E "^$1=" "$SRC/deploy/docker/buildx.pin" | cut -d= -f2-; }
# Только наши команды сборки видят свой buildx; compose и остальное — как у всех.
bx() { DOCKER_CONFIG="$BX_HOME" docker buildx "$@"; }

own_buildx_state() { # ok | missing | wrong
  local dst="$BX_HOME/cli-plugins/docker-buildx" sha
  sha="$(pin "BUILDX_SHA256_$(buildx_arch | tr '[:lower:]' '[:upper:]')")"
  [ -x "$dst" ] || { echo missing; return; }
  [ "$(sha256sum "$dst" | cut -c1-64)" = "$sha" ] && echo ok || echo wrong
}
buildx_arch() {
  case "$(uname -m)" in x86_64) echo amd64 ;; aarch64 | arm64) echo arm64 ;; *) fail "архитектура $(uname -m) не поддержана" ;; esac
}

install_buildx() {
  local ver arch sha dst src tmp
  ver="$(pin BUILDX_VERSION)"; arch="$(buildx_arch)"; sha="$(pin "BUILDX_SHA256_$(printf '%s' "$arch" | tr '[:lower:]' '[:upper:]')")"
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] && [ -n "$ver" ] || fail "в buildx.pin нет версии или суммы для $arch"
  dst="$BX_HOME/cli-plugins/docker-buildx"
  if [ "$(own_buildx_state)" = ok ]; then ok "свой buildx $ver (сумма сверена)"; return 0; fi
  mkdir -p "$BX_HOME/cli-plugins"; chmod 700 "$BX_HOME"
  tmp="$dst.tmp"; rm -f -- "$tmp"
  src="$BX_HOME/buildx-$ver.linux-$arch"
  if [ -f "$src" ]; then
    log "свой buildx $ver — из заранее положенного файла"
    cp "$src" "$tmp"
  else
    log "скачиваю свой buildx $ver (~66 МБ) с GitHub"
    curl -sSfL --retry 3 -o "$tmp" "${OSP_BUILDX_URL:-https://github.com/docker/buildx/releases/download/$ver/buildx-$ver.linux-$arch}" \
      || { rm -f -- "$tmp"; fail "buildx не скачан — положите файл $src (с машины сборки) и повторите"; }
  fi
  [ "$(sha256sum "$tmp" | cut -c1-64)" = "$sha" ] || { rm -f -- "$tmp"; fail "контрольная сумма buildx не совпала с buildx.pin — файл удалён, ничего не установлено"; }
  chmod 755 "$tmp"; mv -f "$tmp" "$dst"
  bx version >/dev/null 2>&1 || fail "свой buildx не запускается"
  ok "свой buildx $ver установлен в $BX_HOME (только для сборки портала)"
}

ensure_builder() {
  local cpu opts image
  install_buildx
  cpu=$(( $(nproc) - 1 ))
  image="$(pin BUILDKIT_IMAGE)"
  [ -n "$image" ] || fail "в buildx.pin нет BUILDKIT_IMAGE"
  opts="image=$image,memory=$BUILD_MEMORY,memory-swap=$BUILD_MEMORY,cpuset-cpus=$cpu,cpu-shares=256,default-load=true"
  if bx inspect "$BUILDER" >/dev/null 2>&1; then
    local info; info="$(bx inspect "$BUILDER" 2>/dev/null)"
    if grep -q "memory=\"$BUILD_MEMORY\"" <<< "$info" && grep -qF "image=\"$image\"" <<< "$info"; then
      ok "сборщик $BUILDER: потолок памяти $BUILD_MEMORY, ядро $cpu"
      return 0
    fi
    log "у сборщика $BUILDER другие настройки — пересоздаю (только свой сборщик)"
    bx rm "$BUILDER" >/dev/null
  fi
  log "создаю свой сборщик $BUILDER: потолок памяти $BUILD_MEMORY, ядро $cpu, пониженный приоритет"
  bx create --name "$BUILDER" --driver docker-container --driver-opt "$opts" >/dev/null
  ok "сборщик $BUILDER создан"
}

# Кэш своего сборщика — не больше 3 ГБ; сам сборщик — остановить: память нужна соседям.
release_builder() {
  bx prune --builder "$BUILDER" --force --max-used-space 3gb >/dev/null 2>&1 \
    || warn "кэш сборщика не почищен — не критично"
  bx stop "$BUILDER" >/dev/null 2>&1 || true
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
  DOCKER_CONFIG="$BX_HOME" OSP_BUILDER="$BUILDER" OSP_WEB_BUILD_ENV="$WEB_ENV" bash "$SRC/deploy/docker/build.sh" "${args[@]}" || rc=$?
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
  bx build --builder "$BUILDER" --load -q -t "$img" -f "$SRC/deploy/docker/tools.Dockerfile" "$SRC/deploy/docker" >/dev/null || rc=$?
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

# ---------- свой вход ----------
env_value() { grep -m 1 -E "^$1=" "$API_ENV" 2>/dev/null | cut -d= -f2- || true; }

# Одна строка в файле окружения API — атомарно (временный файл рядом, 600, затем mv). Значение не выводится.
set_env_line() {
  local name="$1" value="$2" tmp
  [ -f "$API_ENV" ] || fail "нет $API_ENV"
  tmp="$(mktemp "$API_ENV.XXXXXX")"
  chmod 600 "$tmp"
  if grep -q -E "^$name=" "$API_ENV"; then
    NAME="$name" VALUE="$value" awk '{ if (index($0, ENVIRON["NAME"] "=") == 1) print ENVIRON["NAME"] "=" ENVIRON["VALUE"]; else print }' "$API_ENV" > "$tmp"
  else
    { cat "$API_ENV"; printf '%s=%s\n' "$name" "$value"; } > "$tmp"
  fi
  mv -f -- "$tmp" "$API_ENV"
}

# Инструменты своего входа — в том же контейнере, что миграции; ключи и выгрузки — только на чтение.
run_accounts() {
  mkdir -p "$OSP_HOME/reports/db" "$OSP_HOME/backups"
  chmod 700 "$OSP_HOME/reports" "$OSP_HOME/reports/db" "$OSP_HOME/backups"
  local net=() extra=()
  [ -z "${OSP_TOOLS_NETWORK:-}" ] || net=(--network "$OSP_TOOLS_NETWORK")
  [ ! -d "$ACCOUNTS_IN" ] || extra+=(-v "$ACCOUNTS_IN:/in:ro")
  [ ! -f "$TRANSFER_KEY" ] || extra+=(-v "$TRANSFER_KEY:/run/osp/transfer.key:ro")
  extra+=(-v "$API_ENV:/run/osp/osp-api.env:ro")
  docker run --rm "${net[@]}" --user "$(id -u):$(id -g)" --memory 512m --cpus 1 \
    -e HOME=/tmp -e PROBE_REPORT_DIR=/reports -e BACKUP_OUT_DIR=/backups \
    -v "$SRC:/src:ro" -v "$DB_DIR:/db:ro" -v "$OSP_HOME/reports/db:/reports" -v "$OSP_HOME/backups:/backups" "${extra[@]}" \
    -w /src "$(tools_image)" bash "$@"
}

do_auth_key_init() {
  [ -f "$API_ENV" ] || fail "нет $API_ENV"
  [ -z "$(env_value OSP_AUTH_KEYS)" ] || fail "ключ уже есть (OSP_AUTH_KEYS) — второй раз не создаётся"
  local id key
  id="k$(date -u +%Y%m%d)"
  key="$(head -c 32 /dev/urandom | base64 -w0)"
  set_env_line OSP_AUTH_KEYS "$id:$key"
  unset key
  ok "ключ шифрования паролей $id записан в $API_ENV (значение не выводится)"
  warn "сохраните копию $API_ENV офлайн: без ключа пароли своего входа не расшифровать"
}

# Жетон, по которому контейнер сайта верит адресу клиента от общего nginx (deploy/docker/web/nginx.conf).
# После создания: запись общего nginx заново (infra-nginx/install.sh <имя>) и выкладка сайта (frontend).
do_edge_token_init() {
  local file="$OSP_HOME/secrets/osp-web.env"
  if [ -f "$file" ] && grep -q -E '^OSP_EDGE_TOKEN=[A-Za-z0-9]{32,}' "$file"; then
    fail "жетон уже есть: $file"
  fi
  (umask 077; printf 'OSP_EDGE_TOKEN=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> "$file")
  chmod 600 "$file"
  ok "жетон адреса клиента записан в $file (значение не выводится)"
  echo "Дальше: запись общего nginx заново — bash $OSP_HOME/current/infra-nginx/install.sh tender.su10.ru; затем frontend"
}

do_transfer_key_init() {
  command -v openssl >/dev/null || fail "нет openssl"
  [ ! -e "$TRANSFER_KEY" ] || fail "ключ переноса уже есть: $TRANSFER_KEY"
  (umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$TRANSFER_KEY" 2>/dev/null) || fail "ключ переноса не создан"
  mkdir -p "$ACCOUNTS_IN"
  chmod 700 "$OSP_HOME/accounts" "$ACCOUNTS_IN"
  ok "ключ переноса создан: $TRANSFER_KEY (закрытый — только на этом сервере)"
  echo "Открытый ключ — на машину, где снимается копия Supabase (backup.sh --credentials <этот файл>):"
  openssl pkey -in "$TRANSFER_KEY" -pubout
}

do_transfer_key_destroy() {
  if [ -e "$TRANSFER_KEY" ]; then
    shred -u -- "$TRANSFER_KEY" 2>/dev/null || rm -f -- "$TRANSFER_KEY"
  fi
  [ ! -d "$ACCOUNTS_IN" ] || find "$ACCOUNTS_IN" -mindepth 1 -maxdepth 1 -type f -exec rm -f -- {} +
  ok "ключ переноса и файлы выгрузок удалены"
}

do_accounts_check() {
  need_db_files
  ensure_tools
  run_accounts migration/accounts/accounts-check.sh /db/target.env
}

do_accounts_sync() {
  local users="" cred="" manifest="" restore="" yes=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --users) users="${2:-}"; shift 2 ;;
      --credentials) cred="${2:-}"; shift 2 ;;
      --manifest) manifest="${2:-}"; shift 2 ;;
      --restore) restore="${2:-}"; shift 2 ;;
      --yes) yes=1; shift ;;
      *) usage; fail "неизвестный ключ: $1" ;;
    esac
  done
  [ -n "$users" ] && [ -n "$cred" ] || { usage; fail "нужны --users и --credentials (файлы в $ACCOUNTS_IN)"; }
  local f
  for f in "$users" "$cred" ${manifest:+"$manifest"}; do
    [[ "$f" =~ ^[A-Za-z0-9._-]+$ ]] || fail "укажите имя файла из $ACCOUNTS_IN, без пути: $f"
    [ -f "$ACCOUNTS_IN/$f" ] || fail "нет $ACCOUNTS_IN/$f"
  done
  [ -f "$TRANSFER_KEY" ] || fail "нет ключа переноса — сначала transfer-key-init"
  [ -n "$(env_value OSP_AUTH_KEYS)" ] || fail "нет ключа шифрования паролей — сначала auth-key-init"
  need_db_files
  ensure_tools
  local args=(migration/accounts/accounts-sync.sh /db/target.env --users "/in/$users" --credentials "/in/$cred"
    --transfer-key /run/osp/transfer.key --auth-keys-file /run/osp/osp-api.env)
  [ -z "$manifest" ] || args+=(--manifest "/in/$manifest")
  [ -z "$restore" ] || args+=(--restore "$restore")
  log "перенос учёток — проверка (только чтение)"
  run_accounts "${args[@]}" --dry-run || fail "проверка не прошла — база не менялась"
  if [ "$yes" != 1 ]; then
    [ -t 0 ] || fail "нет терминала для вопроса — запустите с --yes"
    local answer
    read -r -p "Записать учётки и пароли в базу нового портала? Перед этим снимается копия базы. [y/N] " answer
    [[ "$answer" =~ ^[yYдД]$ ]] || { warn "отменено — база не менялась"; return 0; }
  fi
  run_accounts "${args[@]}" --yes || fail "перенос учёток остановлен — подробности выше; отчёт — $OSP_HOME/reports/db"
  warn "удалите файлы выгрузки из $ACCOUNTS_IN, когда они больше не нужны (transfer-key-destroy — вместе с ключом)"
}

auth_mode_now() { bash "$OSP_HOME/deploy.sh" auth-config 2>/dev/null | grep -o '"mode":"[a-z]*"' | cut -d'"' -f4; }

do_auth_mode() {
  local mode="${1:-}" prev
  case "$mode" in supabase | both | own) ;; *) usage; fail "режим входа: supabase | both | own" ;; esac
  [ -f "$API_ENV" ] || fail "нет $API_ENV"
  prev="$(env_value AUTH_MODE)"; prev="${prev:-supabase}"
  if [ "$mode" != supabase ]; then
    [ -n "$(env_value OSP_AUTH_KEYS)" ] || fail "нет ключа шифрования паролей — сначала auth-key-init"
    [ -n "$(env_value OSP_PUBLIC_ORIGIN)" ] || fail "в $API_ENV не задан OSP_PUBLIC_ORIGIN (https://tender.su10.ru)"
  fi
  [ "$mode" != both ] || [ -n "$(env_value OSP_AUTH_PILOT_IDS)" ] || fail "для both нужен OSP_AUTH_PILOT_IDS (кто проверяет свой вход)"
  if [ "$mode" = own ]; then
    log "свежая проверка готовности своего входа"
    do_accounts_check || fail "свой вход не готов — режим не меняется"
  fi
  log "режим входа: $prev → $mode"
  set_env_line AUTH_MODE "$mode"
  if bash "$OSP_HOME/deploy.sh" api-restart && [ "$(auth_mode_now)" = "$mode" ]; then
    ok "вход переключён: $mode"
    return 0
  fi
  warn "API в режиме $mode не прошёл проверку — возвращаю $prev"
  set_env_line AUTH_MODE "$prev"
  bash "$OSP_HOME/deploy.sh" api-restart || warn "и с прежним режимом API не отвечает — смотрите журналы"
  fail "режим входа не изменён (остался $prev)"
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
  case "$(own_buildx_state)" in
    ok) ok "свой buildx $(pin BUILDX_VERSION) установлен (сумма сверена)" ;;
    wrong) warn "свой buildx в $BX_HOME не совпадает с buildx.pin — при сборке будет заменён" ;;
    *) if [ -f "$BX_HOME/buildx-$(pin BUILDX_VERSION).linux-$(buildx_arch)" ]; then ok "файл buildx положен заранее — установится при первой сборке"
       else warn "своего buildx ещё нет — при первой сборке скачается с GitHub (~66 МБ) или положите $BX_HOME/buildx-$(pin BUILDX_VERSION).linux-$(buildx_arch)"; fi ;;
  esac
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
    auth-key-init)        preflight; do_auth_key_init ;;
    edge-token-init)      preflight; do_edge_token_init ;;
    transfer-key-init)    preflight; do_transfer_key_init ;;
    transfer-key-destroy) preflight; do_transfer_key_destroy ;;
    accounts-check)       preflight; do_accounts_check ;;
    accounts-sync)
      preflight
      exec 9>"$OSP_HOME/.deploy-server.lock"; flock -n 9 || fail "уже идёт другая выкладка или миграция"
      shift; do_accounts_sync "$@" ;;
    auth-mode)
      preflight
      exec 9>"$OSP_HOME/.deploy-server.lock"; flock -n 9 || fail "уже идёт другая выкладка или миграция"
      do_auth_mode "${2:-}" ;;
    rollback)             preflight; bash "$OSP_HOME/deploy.sh" rollback ;;
    -h | --help)          usage ;;
    "")                   usage; exit 1 ;;
    *)                    usage; fail "неизвестный режим: $scope" ;;
  esac
}

main "$@"
