# Образ сайта портала: сборка Vite + nginx. Собирается из корня репозитория (deploy/docker/build.sh):
#
#   docker build -f deploy/docker/web.Dockerfile -t osp-web:<коммит> \
#     --build-arg VITE_SUPABASE_URL=… --build-arg VITE_SUPABASE_ANON_KEY=… --build-arg OSP_BUILD_ID=… .
#
# Адрес и публичный ключ Supabase — не секреты: они вшиты в любую сборку сайта и видны в браузере.
# OSP_BUILD_ID — идентификатор сборки (метка времени); по нему вкладки узнают о новой версии.
#
# Сайт отдаётся не из образа, а из тома /var/www/osp: при запуске контейнера сборка выкладывается туда
# тем же deploy/publish.sh, что и раньше (каталоги-релизы, общий каталог хэш-файлов недавних сборок) —
# вкладка, открытая до выкладки, по-прежнему догружает файлы своей сборки. nginx — не от root.
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js release.json ./
COPY public ./public
COPY src ./src
ARG VITE_SUPABASE_URL=
ARG VITE_SUPABASE_ANON_KEY=
ARG OSP_BUILD_ID=
RUN VITE_SUPABASE_URL="$VITE_SUPABASE_URL" VITE_SUPABASE_ANON_KEY="$VITE_SUPABASE_ANON_KEY" \
    OSP_BUILD_ID="$OSP_BUILD_ID" npm run build

FROM nginx:1.29-alpine
# publish.sh: bash, rsync, GNU find (-printf), node — прочитать version.json.
RUN apk add --no-cache bash rsync findutils coreutils nodejs \
 && rm -f /etc/nginx/conf.d/default.conf \
 && mkdir -p /var/www/osp /etc/osp/shared \
 && chown nginx:nginx /var/www/osp
COPY --from=build /src/dist /opt/osp/dist
COPY deploy/publish.sh /opt/osp/publish.sh
COPY deploy/docker/web/entrypoint.sh /opt/osp/entrypoint.sh
COPY deploy/docker/web/nginx.conf /etc/nginx/nginx.conf
COPY deploy/docker/web/site.conf /etc/nginx/conf.d/site.conf
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/version.json || exit 1
ENTRYPOINT ["bash", "/opt/osp/entrypoint.sh"]
