# syntax=docker/dockerfile:1.7
# ---- build web + server ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --workspaces --include-workspace-root
COPY . .
RUN npm run build --workspace web && npm run build --workspace server
RUN npm prune --omit=dev --workspaces --include-workspace-root || true

# ---- runtime: Node + bundled dockerd (DinD) ----
FROM docker:27-dind AS runtime
COPY --from=build /usr/local/bin/node /usr/local/bin/node
RUN apk add --no-cache libstdc++ tini bash curl tar iptables
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/migrations ./server/migrations
COPY --from=build /app/web/dist ./web/dist
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    INSTALL_TYPE=docker \
    PORT=8080 \
    DATA_DIR=/data \
    DOCKER_HOST=unix:///var/run/docker.sock \
    DOCKER_NETWORK=servcrafty \
    PORT_POOL_DEFAULT=25565-25600

VOLUME ["/data", "/var/lib/docker"]
EXPOSE 8080 25565-25600
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD curl -fs http://localhost:8080/api/health || exit 1
# Needs: docker run --privileged (bundled dockerd)
ENTRYPOINT ["/sbin/tini","--","/usr/local/bin/entrypoint.sh"]
