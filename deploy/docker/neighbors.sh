#!/usr/bin/env bash
# Соседи по серверу не пострадали: снимок до работ и сравнение после. ТОЛЬКО ЧТЕНИЕ.
#
#   bash neighbors.sh --save      # снимок: перед установкой, выкладкой, правкой общего nginx
#   bash neighbors.sh --compare   # сравнить сервер с последним снимком
#
# На сервере рядом работают другие проекты. Выкладка портала действует только на свой проект Compose,
# но требование «соседи не должны пострадать» проверяется и по факту:
#   • каждый чужой контейнер из снимка на месте, работает, не перезапускался и на том же образе;
#   • порты, которые сервер слушал снаружи, по-прежнему слушаются (адреса 127.0.0.1 не сравниваются:
#     это внутренние порты служб, их состояние видно по контейнерам);
#   • память и диск: предупреждение, если свободного стало мало.
# Контейнеры проекта портала (OSP_PROJECT, по умолчанию osp) и его сборщик buildx в сравнение не входят. В чужие контейнеры
# скрипт не заходит и их настроек не читает: только имя, состояние, время запуска и отпечаток образа.
# Выход: 0 — без замечаний или только «ВНИМАНИЕ»; 1 — ошибка запуска; 3 — FAIL.
set -euo pipefail
OSP_HOME="${OSP_HOME:-/opt/portals/osp}"
PROJECT="${OSP_PROJECT:-osp}"
# Свой сборщик buildx (scripts/deploy-server.sh) — не сосед: он запускается на время сборки и останавливается.
BUILDER="${OSP_BUILDER:-osp-builder}"
REPORT_DIR="${OSP_REPORT_DIR:-$OSP_HOME/reports}"
MODE="${1:-}"
case "$MODE" in --save | --compare) ;; *) echo "Использование: bash neighbors.sh --save | --compare" >&2; exit 1 ;; esac
for bin in docker python3 ss df; do command -v "$bin" >/dev/null || { echo "Нужен $bin" >&2; exit 1; }; done
mkdir -p "$REPORT_DIR"; chmod 700 "$REPORT_DIR"
NOW="$REPORT_DIR/server-neighbors-$(date -u +%Y%m%d-%H%M%S).tsv"

# Снимок: строки «container / port / mem / disk», разделитель — табуляция.
{
  ids="$(docker ps -aq)"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    docker inspect $ids --format '{{.Name}}{{"\t"}}{{index .Config.Labels "com.docker.compose.project"}}{{"\t"}}{{.State.Status}}{{"\t"}}{{.State.StartedAt}}{{"\t"}}{{.RestartCount}}{{"\t"}}{{.Image}}' |
      awk -F'\t' -v own="$PROJECT" -v builder="/buildx_buildkit_$BUILDER" \
        '$2 != own && index($1, builder) != 1 { sub(/^\//, "", $1); print "container\t" $1 "\t" $3 "\t" $4 "\t" $5 "\t" $6 }'
  fi
  ss -ltnH | awk '$4 !~ /^(127\.|\[::1\])/ { print "port\t" $4 }' | sort -u
  awk '/^MemAvailable:/ { print "mem\t" int($2 / 1024) }' /proc/meminfo
  df -Pm / | awk 'NR == 2 { print "disk\t" $4 }'
} > "$NOW"

if [ "$MODE" = --save ]; then
  echo "OK снимок сервера сохранён: чужих контейнеров — $(grep -c '^container' "$NOW" || true), портов — $(grep -c '^port' "$NOW" || true), доступно памяти — $(awk -F'\t' '$1 == "mem" { print $2 }' "$NOW") МБ"
  echo "Файл: $NOW"
  exit 0
fi
PREV="$(ls -1 "$REPORT_DIR"/server-neighbors-*.tsv 2>/dev/null | grep -v "$(basename "$NOW")" | sort | tail -n 1 || true)"
if [ -z "$PREV" ]; then
  echo "FAIL прежнего снимка нет: сначала --save (до работ)"; rm -f "$NOW"; exit 3
fi
echo "Сравнение сервера со снимком $(basename "$PREV" .tsv | sed 's/server-neighbors-//') UTC"
rc=0
python3 - "$PREV" "$NOW" <<'PY' || rc=$?
import sys

def read(path):
    containers, ports, mem, disk = {}, set(), None, None
    for line in open(path, encoding='utf-8'):
        f = line.rstrip('\n').split('\t')
        if f[0] == 'container' and len(f) >= 6:
            containers[f[1]] = {'state': f[2], 'started': f[3], 'restarts': f[4], 'image': f[5]}
        elif f[0] == 'port' and len(f) >= 2:
            ports.add(f[1])
        elif f[0] == 'mem':
            mem = int(f[1])
        elif f[0] == 'disk':
            disk = int(f[1])
    return containers, ports, mem, disk

before, ports_before, mem_before, disk_before = read(sys.argv[1])
after, ports_after, mem_after, disk_after = read(sys.argv[2])
fail = False

missing = sorted(n for n in before if n not in after)
stopped = sorted(n for n in before if n in after and before[n]['state'] == 'running' and after[n]['state'] != 'running')
restarted = sorted(n for n in before if n in after and before[n]['state'] == 'running' and after[n]['state'] == 'running'
                   and (before[n]['started'] != after[n]['started'] or before[n]['restarts'] != after[n]['restarts']))
reimaged = sorted(n for n in before if n in after and before[n]['image'] != after[n]['image'])
for bad, text in ((missing, 'пропали'), (stopped, 'остановлены'), (restarted, 'перезапускались'), (reimaged, 'сменили образ')):
    if bad:
        fail = True
        print(f"FAIL чужие контейнеры {text}: {', '.join(bad)}")
if not (missing or stopped or restarted or reimaged):
    print(f"OK чужих контейнеров в снимке: {len(before)}; все на месте, работают, не перезапускались, образы прежние")
new = sorted(n for n in after if n not in before)
if new:
    print(f"ИНФО новых чужих контейнеров: {len(new)}")

lost = sorted(ports_before - ports_after)
if lost:
    fail = True
    print(f"FAIL сервер перестал слушать: {', '.join(lost)}")
else:
    print(f"OK порты сервера: все {len(ports_before)} из снимка слушаются")
opened = sorted(ports_after - ports_before)
if opened:
    print(f"ВНИМАНИЕ сервер начал слушать новые адреса: {', '.join(opened)}")

if mem_after is not None:
    note = 'ВНИМАНИЕ' if mem_after < 400 else 'OK'
    print(f"{note} доступно памяти: {mem_after} МБ (в снимке — {mem_before} МБ)")
if disk_after is not None:
    note = 'ВНИМАНИЕ' if disk_after < 5000 else 'OK'
    print(f"{note} свободно на диске: {disk_after} МБ (в снимке — {disk_before} МБ)")
sys.exit(3 if fail else 0)
PY
# Текущий снимок при сравнении не сохраняется как точка отсчёта: она задаётся только явным --save.
rm -f "$NOW"
exit "$rc"
