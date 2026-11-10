# ServCrafty SteamCMD image: SteamCMD + Wine/Xvfb + the executor (servcrafty-steam-run).
# Build context: docker/steam/   (docker build -t servcrafty-steamcmd docker/steam)

FROM node:22-bookworm-slim AS node

FROM debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive
ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    WINEDEBUG=-all \
    HOME=/data/steam

# SteamCMD needs the 32-bit libs; Windows servers run under Debian's Wine (64 and 32 bit) on a virtual X display.
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl locales procps tini util-linux unzip xz-utils \
      lib32gcc-s1 lib32stdc++6 libatomic1 libcurl4 libsdl2-2.0-0 \
      wine wine64 wine32:i386 libwine libwine:i386 fonts-wine \
      xvfb xauth winbind cabextract \
 && sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
 && locale-gen \
 && rm -rf /var/lib/apt/lists/*

# Non-root user the game runs as (Satisfactory refuses root).
RUN groupadd -g 1000 steam \
 && useradd -u 1000 -g 1000 -d /data/steam -s /bin/bash -M steam

# SteamCMD from Valve's official tarball.
RUN mkdir -p /opt/steamcmd \
 && curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar -xz -C /opt/steamcmd \
 && chown -R 1000:1000 /opt/steamcmd \
 && ln -s /opt/steamcmd/steamcmd.sh /usr/local/bin/steamcmd \
 && mkdir -p /tmp/steamwarm && chown 1000:1000 /tmp/steamwarm \
 && (setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/tmp/steamwarm /opt/steamcmd/steamcmd.sh +quit || true) \
 && rm -rf /tmp/steamwarm

# Node runtime for the executor only (no npm dependencies).
COPY --from=node /usr/local/bin/node /usr/local/bin/node

COPY src /opt/servcrafty-steam/src
RUN printf '#!/bin/sh\nexec node /opt/servcrafty-steam/src/main.js "$@"\n' > /usr/local/bin/servcrafty-steam-run \
 && chmod 0755 /usr/local/bin/servcrafty-steam-run \
 && mkdir -p /data /servcrafty

WORKDIR /data
ENTRYPOINT ["tini", "--", "/usr/local/bin/servcrafty-steam-run"]
