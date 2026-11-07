#!/bin/bash
set -e

: "${SECRET_KEY:?SECRET_KEY must be set (>=32 chars)}"
: "${DATABASE_URL:?DATABASE_URL must be set}"

mkdir -p "${DATA_DIR:-/data}/servers" "${DATA_DIR:-/data}/backups"

if [ "${EXTERNAL_DOCKER:-0}" != "1" ]; then
  echo "[servcrafty] starting bundled dockerd..."
  dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock >/var/log/dockerd.log 2>&1 &
  for i in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
  docker info >/dev/null 2>&1 || { echo "dockerd failed to start (is the container --privileged?)"; tail -n 50 /var/log/dockerd.log; exit 1; }
fi

docker network inspect "${DOCKER_NETWORK:-servcrafty}" >/dev/null 2>&1 || docker network create "${DOCKER_NETWORK:-servcrafty}"

echo "[servcrafty] starting app"
exec node /app/server/dist/index.js
