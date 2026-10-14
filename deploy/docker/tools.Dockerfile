# Инструменты базы нового портала для сервера: migration/target/*.sh (migrate.sh, export.sh, neighbors.sh,
# pin.sh) работают в этом контейнере, а не на хосте — на сервере нет ни psql, ни node. Скрипты в образ не
# копируются: их даёт клон репозитория на сервере (только чтение), так что образ меняется лишь с этим файлом.
#
#   docker buildx build --builder osp-builder --load -t osp-tools:<отпечаток файла> -f deploy/docker/tools.Dockerfile deploy/docker
#
# Собирает и запускает scripts/deploy-server.sh migrate. Клиент PostgreSQL 17 — как сервер базы Яндекса;
# GNU grep, sed, findutils, coreutils — скрипты рассчитаны на них (\b в выражениях, find -printf).
FROM node:24-alpine
RUN apk add --no-cache bash coreutils findutils grep sed gzip postgresql17-client
USER node
WORKDIR /src
