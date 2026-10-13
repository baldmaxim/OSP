#!/usr/bin/env bash
# Выкладка портала ОСП на сервере (Docker Compose, проект osp). Запускать от владельца каталога портала:
#
#   bash deploy.sh install <каталог выпуска>   # сверить суммы, загрузить образы, выложить, проверить
#   bash deploy.sh rollback                    # вернуть предыдущий выпуск (его образы уже на сервере)
#   bash deploy.sh status                      # что выложено и отвечает ли
#
# Каталог выпуска собирает deploy/docker/build.sh на машине сборки; на сервере ничего не собирается.
# Первый раз скрипт запускается из каталога выпуска; после установки он же (и neighbors.sh) лежит в
# каталоге портала: bash /opt/portals/osp/deploy.sh status.
#
# Каталог портала OSP_HOME (/opt/portals/osp) — создаётся один раз при установке (deploy/docker/README.md):
#   server.env                 — OSP_PROXY_NETWORK=<сеть общего nginx сервера>
#   secrets/osp-api.env, secrets/postgrest.env — настройки с ключами, права 600
#   certs/yandex-root.crt      — корневой сертификат базы (не секрет)
#   shared/config.json         — флаги портала (необязателен)
#   state/                     — барьер записи: файл state/db-readonly
#   compose.server.yml         — необязательные правки под этот сервер (добавляются к compose.yml выпуска)
#   releases/<метка>/, current, previous — выложенные выпуски; пишет этот скрипт
#
# Соседи по серверу. Скрипт работает только с проектом Compose «osp» и образами osp-api / osp-web со
# своими метками: общих команд Docker (prune, остановка всех контейнеров, удаление томов) в нём нет,
# общий nginx сервера он не трогает. Новый выпуск не прошёл проверку — возвращается прежний; прежнего
# нет (первая установка) — проект останавливается: непроверенный выпуск не работает.
set -euo pipefail

OSP_HOME="${OSP_HOME:-/opt/portals/osp}"
PROJECT="${OSP_PROJECT:-osp}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
HEALTH_TRIES="${HEALTH_TRIES:-45}"
HEALTH_PAUSE="${HEALTH_PAUSE:-2}"

die() { echo "FAIL $*" >&2; exit 1; }
for bin in docker flock sha256sum; do command -v "$bin" >/dev/null || die "нужен $bin"; done

# Отпечаток образа: слои и параметры запуска. Номер образа (.Id) для сверки не годится — он зависит от
# того, как Docker на машине хранит образы, и у машины сборки и сервера может не совпадать при одном и
# том же содержимом. Пустая строка — образа нет.
image_print() {
  local out
  out="$(docker image inspect "$1" --format '{{json .RootFS.Layers}}|{{json .Config.Entrypoint}}|{{json .Config.Cmd}}|{{json .Config.Env}}|{{.Config.User}}|{{.Config.WorkingDir}}|{{.Os}}/{{.Architecture}}' 2>/dev/null)" || return 0
  printf '%s' "$out" | sha256sum | cut -d' ' -f1
}
# Для машины сборки (deploy/docker/build.sh): тот же отпечаток, каталог портала не нужен.
if [ "${1:-}" = fingerprint ]; then
  [ -n "${2:-}" ] || die "укажите образ"
  image_print "$2"
  exit 0
fi

docker compose version >/dev/null 2>&1 || die "нужен docker compose"
[ -d "$OSP_HOME" ] || die "нет каталога портала $OSP_HOME"

exec 9>"$OSP_HOME/.deploy.lock"
flock -n 9 || die "выкладка уже идёт"

release_of() { if [ -L "$OSP_HOME/$1" ]; then basename "$(readlink "$OSP_HOME/$1")"; fi; }
point() { # point <current|previous> <метка> — атомарно
  ln -sfn "releases/$2" "$OSP_HOME/.$1.tmp"
  mv -T "$OSP_HOME/.$1.tmp" "$OSP_HOME/$1"
}
# Только наш проект: имя проекта, каталог и файлы заданы явно.
dc() { # dc <метка> <команда compose…>
  local rel="$OSP_HOME/releases/$1" extra=()
  if [ -f "$OSP_HOME/compose.server.yml" ]; then extra=(-f "$OSP_HOME/compose.server.yml"); fi
  docker compose -p "$PROJECT" --project-directory "$OSP_HOME" -f "$rel/compose.yml" "${extra[@]}" \
    --env-file "$rel/release.env" --env-file "$OSP_HOME/server.env" "${@:2}"
}

# Что должно лежать на сервере до выкладки. Значения ключей не читаются и не выводятся.
preflight() {
  local f mode
  [ -f "$OSP_HOME/server.env" ] || die "нет $OSP_HOME/server.env (OSP_PROXY_NETWORK=<сеть общего nginx>)"
  local net
  net="$(grep -m 1 -E '^OSP_PROXY_NETWORK=' "$OSP_HOME/server.env" | cut -d= -f2-)"
  [ -n "$net" ] || die "в server.env не задана OSP_PROXY_NETWORK"
  docker network inspect "$net" >/dev/null 2>&1 || die "сети общего nginx «$net» на сервере нет"
  for f in secrets/osp-api.env secrets/postgrest.env; do
    [ -f "$OSP_HOME/$f" ] || die "нет $OSP_HOME/$f"
    mode="$(stat -c '%a' "$OSP_HOME/$f")"
    [ "$mode" = 600 ] || [ "$mode" = 400 ] || die "$f доступен не только владельцу (права $mode): нужно 600"
  done
  [ -s "$OSP_HOME/certs/yandex-root.crt" ] || die "нет корневого сертификата базы: $OSP_HOME/certs/yandex-root.crt"
  mkdir -p "$OSP_HOME/shared" "$OSP_HOME/state" "$OSP_HOME/releases"
}

# Готовность: API отвечает на /api/ready «ok» (обязательные зависимости проверены с текущими ключами),
# сайт отдаёт version.json, запрос сайта к API проходит. Проверки идут изнутри контейнеров — портов на
# сервере проект не открывает. В выводе готовности только ok / fail / not_configured.
READY_JS='fetch("http://127.0.0.1:8787/api/ready").then(async (r) => { process.stdout.write(await r.text()); process.exit(r.status === 200 ? 0 : 3) }).catch(() => process.exit(4))'
healthy() {
  local tag="$1" i out rc fails=0
  for ((i = 0; i < HEALTH_TRIES; i++)); do
    rc=0; out="$(dc "$tag" exec -T api node -e "$READY_JS" 2>/dev/null)" || rc=$?
    if [ "$rc" = 0 ]; then
      if dc "$tag" exec -T web wget -q -O /dev/null http://127.0.0.1:8080/version.json 2>/dev/null \
        && dc "$tag" exec -T web wget -q -O /dev/null http://127.0.0.1:8080/api/health 2>/dev/null; then
        echo "Готовность: $out"
        return 0
      fi
    elif [ "$rc" = 3 ]; then
      fails=$((fails + 1))
      if [ "$fails" -ge 5 ]; then echo "Готовность: зависимости не отвечают — $out"; return 1; fi
    fi
    sleep "$HEALTH_PAUSE"
  done
  echo "Готовность: службы не ответили за $((HEALTH_TRIES * HEALTH_PAUSE)) с"
  return 1
}

switch_to() { # switch_to <метка>; при отказе — назад на прежнюю
  local target="$1" before
  before="$(release_of current)"
  point current "$target"
  dc "$target" up -d --remove-orphans
  if healthy "$target"; then
    if [ -n "$before" ] && [ "$before" != "$target" ]; then point previous "$before"; fi
    echo "OK портал работает: выпуск $target"
    return 0
  fi
  echo "Выпуск $target не прошёл проверку"
  if [ -n "$before" ] && [ "$before" != "$target" ]; then
    point current "$before"
    dc "$before" up -d --remove-orphans
    if healthy "$before"; then echo "Возвращён прежний выпуск $before — работает"; else echo "Прежний выпуск $before тоже не отвечает"; fi
  elif [ -z "$before" ]; then
    dc "$target" down
    rm -f "$OSP_HOME/current"
    echo "Прежнего выпуска нет — проект остановлен"
  fi
  echo "Причина — в журналах: docker compose -p $PROJECT logs --tail 50 api postgrest web"
  return 1
}

case "${1:-}" in
  status)
    cur="$(release_of current)"
    [ -n "$cur" ] || { echo "Портал не выложен"; exit 1; }
    echo "Выпуск: $cur; предыдущий: $(release_of previous || true)"
    dc "$cur" ps
    healthy "$cur"
    ;;

  rollback)
    preflight
    prev="$(release_of previous)"
    [ -n "$prev" ] && [ -d "$OSP_HOME/releases/$prev" ] || die "предыдущего выпуска нет"
    switch_to "$prev"
    ;;

  install)
    REL="${2:-}"
    [ -n "$REL" ] && [ -d "$REL" ] || die "укажите каталог выпуска: bash deploy.sh install <каталог>"
    REL="$(cd "$REL" && pwd)"
    preflight
    # 1. Выпуск дошёл целиком и без изменений.
    (cd "$REL" && sha256sum --quiet -c SHA256SUMS) || die "контрольные суммы выпуска не совпали — файлы повреждены при переносе"
    TAG="$(grep -m 1 -E '^tag=' "$REL/MANIFEST" | cut -d= -f2)"
    [[ "$TAG" =~ ^[0-9a-f]{12}$ ]] || die "в MANIFEST нет метки выпуска"
    # 2. Образы: загрузить из выпуска (если они в нём есть) и в любом случае сверить отпечатки —
    #    работать будут ровно те образы, что собраны для этого выпуска.
    if [ -f "$REL/images.tar.gz" ]; then
      echo "Загрузка образов выпуска $TAG…"
      docker load -q -i "$REL/images.tar.gz" >/dev/null
    fi
    while read -r _ ref print; do
      got="$(image_print "$ref")"
      [ -n "$got" ] || die "образа $ref на сервере нет"
      [ "$got" = "$print" ] || die "образ $ref на сервере не тот, что в выпуске"
    done < <(grep -E '^image ' "$REL/MANIFEST")
    # 3. Файлы выпуска — в каталог портала (секреты, флаги и состояние не затрагиваются).
    stage="$OSP_HOME/releases/.$TAG.tmp"
    rm -rf "$stage"; mkdir -p "$stage"
    cp "$REL/compose.yml" "$REL/release.env" "$REL/MANIFEST" "$stage/"
    rm -rf "$OSP_HOME/releases/$TAG"
    mv -T "$stage" "$OSP_HOME/releases/$TAG"
    # 4. Переключение с проверкой.
    switch_to "$TAG" || exit 1
    # Скрипты этого выпуска — в каталог портала (заменой файла целиком: выполняемый скрипт не правится).
    for f in deploy.sh neighbors.sh; do
      cp "$REL/$f" "$OSP_HOME/.$f.tmp" && mv -f "$OSP_HOME/.$f.tmp" "$OSP_HOME/$f"
    done
    # 5. Уборка: старые выпуски и ИХ образы (только osp-api / osp-web с метками этих выпусков).
    cur="$(release_of current)"; prev="$(release_of previous)"
    mapfile -t old < <(find "$OSP_HOME/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %f\n' | sort -rn | awk '{print $2}')
    n=0
    for r in "${old[@]}"; do
      n=$((n + 1))
      if [ "$n" -gt "$KEEP_RELEASES" ] && [ "$r" != "$cur" ] && [ "$r" != "$prev" ] && [[ "$r" =~ ^[0-9a-f]{12}$ ]]; then
        rm -rf "${OSP_HOME:?}/releases/$r"
        docker image rm "osp-api:$r" "osp-web:$r" >/dev/null 2>&1 || true
      fi
    done
    ;;

  *)
    echo "Использование: bash deploy.sh install <каталог выпуска> | rollback | status" >&2
    exit 1
    ;;
esac
