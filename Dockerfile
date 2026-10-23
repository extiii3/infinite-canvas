# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 运行镜像：只启动静态前端，AI 请求由浏览器前台直连用户自己的接口。
FROM nginx:1.27-alpine

COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY web/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
COPY --from=ghcr.io/hacdias/webdav:latest /bin/webdav /usr/local/bin/webdav
COPY webdav.yml /etc/webdav.yml
COPY webdav-start.sh /docker-entrypoint.d/50-webdav.sh
COPY upstreams-gen.sh /docker-entrypoint.d/45-upstreams.sh
RUN mkdir -p /etc/nginx/upstreams && chmod +x /docker-entrypoint.d/40-runtime-config.sh /docker-entrypoint.d/45-upstreams.sh /docker-entrypoint.d/50-webdav.sh

EXPOSE 3000
