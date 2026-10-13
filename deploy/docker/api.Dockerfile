# Образ своего API портала (server/osp-api). Собирается из корня репозитория (deploy/docker/build.sh):
#
#   docker build -f deploy/docker/api.Dockerfile -t osp-api:<коммит> .
#
# Зависимости — ровно по package-lock.json. Секретов в образе нет: ключи приходят из файла настроек на
# сервере (compose.yml, env_file). Процесс — не от root; файловая система контейнера только на чтение.
FROM node:24-alpine AS deps
WORKDIR /app
COPY server/osp-api/package.json server/osp-api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server/osp-api/package.json ./
COPY server/osp-api/src ./src
USER node
EXPOSE 8787
# Жив ли процесс. Готовность зависимостей (/api/ready) проверяет выкладка — deploy/docker/deploy.sh.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "src/server.js"]
