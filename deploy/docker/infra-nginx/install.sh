#!/usr/bin/env bash
# Запись портала ОСП в общем nginx сервера: поставить, заменить или убрать — с проверкой и возвратом.
# Запускать от владельца каталога записей, без sudo:
#
#   bash install.sh <имя сайта> --http-only   # шаг 1: запись «только HTTP» (до выпуска сертификата)
#   bash install.sh <имя сайта>               # шаг 2: полная запись, сертификат имени уже выпущен
#   bash install.sh <имя сайта> --remove      # убрать запись этого имени
#
# Это единственное место, где портал касается общей части сервера, поэтому скрипт действует так, чтобы
# общий nginx ни в какой момент не остался с негодными настройками:
#   1. До любых изменений настройки общего nginx должны проходить проверку (nginx -t). Не проходят —
#      скрипт ничего не трогает: чинить чужую поломку не его дело.
#   2. Имя сайта не должно встречаться в чужих записях.
#   3. Файл записи кладётся целиком (переименованием), затем — проверка настроек.
#   4. Проверка не прошла — прежнее состояние возвращается (прежний файл либо отсутствие файла), и
#      проверка повторяется: скрипт уходит, только убедившись, что настройки снова годны. Перечитывания нет.
#   5. Проверка прошла — настройки перечитываются (nginx -s reload). Контейнер не перезапускается:
#      перечитывание не рвёт соединения остальных сайтов.
# Скрипт пишет только файл <имя сайта>.conf в каталоге записей и временные файлы с точкой в начале имени
# (их nginx не читает). Чужие записи он не открывает на запись и не удаляет.
#
# INFRA_NGINX — контейнер общего nginx (по умолчанию infra-nginx); INFRA_CONF_DIR — каталог записей на
# сервере (по умолчанию /opt/infra/nginx/conf.d), в контейнере это /etc/nginx/conf.d.
# Выход: 0 — сделано; 1 — ошибка запуска, ничего не менялось; 3 — запись не принята, прежнее состояние возвращено.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="${INFRA_NGINX:-infra-nginx}"
DIR="${INFRA_CONF_DIR:-/opt/infra/nginx/conf.d}"
NAME="${1:-}"; MODE="${2:-}"
usage() { echo "Использование: bash install.sh <имя сайта> [--http-only | --remove]" >&2; exit 1; }
[[ "$NAME" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || usage
case "$MODE" in '' | --http-only | --remove) ;; *) usage ;; esac
command -v docker >/dev/null || { echo "Нужен docker" >&2; exit 1; }
[ -d "$DIR" ] && [ -w "$DIR" ] || { echo "FAIL каталог записей общего nginx недоступен на запись: $DIR" >&2; exit 1; }
[ "$(docker inspect "$CONTAINER" --format '{{.State.Status}}' 2>/dev/null)" = running ] \
  || { echo "FAIL контейнер общего nginx «$CONTAINER» не работает — ничего не меняется" >&2; exit 1; }

FILE="$DIR/$NAME.conf"
NEW="$DIR/.osp-$NAME.new"
PREV="$DIR/.osp-$NAME.prev"
config_ok() { docker exec "$CONTAINER" nginx -t >/dev/null 2>&1; }

# 1. Общие настройки годны до нас.
config_ok || { echo "FAIL настройки общего nginx не проходят проверку ещё до изменений — ничего не меняется" >&2; exit 1; }

# 2. Имя сайта не занято чужой записью (ищем в остальных файлах каталога; свой файл не в счёт).
if [ "$MODE" != --remove ]; then
  taken="$(grep -lE "^[[:space:]]*server_name[[:space:]]+([^;]*[[:space:]])?${NAME//./\\.}([[:space:]]|;)" "$DIR"/*.conf 2>/dev/null | grep -vxF "$FILE" || true)"
  [ -z "$taken" ] || { echo "FAIL имя $NAME уже есть в другой записи общего nginx: $(basename "$taken" | head -n 1) — ничего не меняется" >&2; exit 1; }
fi

restore() { # вернуть прежнее состояние и убедиться, что настройки годны
  if [ -f "$PREV" ]; then mv -f "$PREV" "$FILE"; else rm -f -- "$FILE"; fi
  if config_ok; then
    echo "Прежнее состояние возвращено, настройки общего nginx годны; перечитывания не было"
  else
    echo "ВНИМАНИЕ после возврата настройки общего nginx не проходят проверку — нужен разбор вручную: docker exec $CONTAINER nginx -t" >&2
  fi
}

rm -f -- "$PREV" "$NEW"
if [ -f "$FILE" ]; then cp -p "$FILE" "$PREV"; fi

if [ "$MODE" = --remove ]; then
  [ -f "$FILE" ] || { echo "Записи $NAME в общем nginx нет — менять нечего"; exit 0; }
  rm -f -- "$FILE"
else
  bash "$HERE/render.sh" "$NAME" ${MODE:+"$MODE"} > "$NEW"
  chmod 644 "$NEW"
  mv -f "$NEW" "$FILE"
fi

# 3–4. Проверка; при отказе — возврат.
if ! out="$(docker exec "$CONTAINER" nginx -t 2>&1)"; then
  echo "FAIL общий nginx не принял запись $NAME: $(printf '%s\n' "$out" | grep -m 1 -E 'emerg|error' | cut -c1-200)"
  restore
  exit 3
fi

# 5. Перечитывание без перезапуска.
docker exec "$CONTAINER" nginx -s reload >/dev/null 2>&1 || { echo "FAIL перечитывание не выполнено"; restore; exit 3; }
sleep 1
[ "$(docker inspect "$CONTAINER" --format '{{.State.Status}}')" = running ] || { echo "FAIL контейнер общего nginx остановился после перечитывания" >&2; exit 3; }
rm -f -- "$PREV"
case "$MODE" in
  --remove) echo "OK запись $NAME убрана из общего nginx, настройки перечитаны" ;;
  --http-only) echo "OK запись $NAME (только HTTP) в общем nginx, настройки перечитаны. Дальше — сертификат имени, затем: bash install.sh $NAME" ;;
  *) echo "OK запись $NAME в общем nginx, настройки перечитаны" ;;
esac
