# ServCrafty

A self-hosted web panel for running and managing Minecraft servers. Each server runs in its own Docker container; you manage them from a browser (or a phone) with live monitoring, a console, file editor, backups, sharing and more.

[![Release workflow](https://github.com/joaquincabrerasimoes/ServCrafty/actions/workflows/release.yml/badge.svg)](https://github.com/joaquincabrerasimoes/ServCrafty/actions/workflows/release.yml)

![Server overview with live memory, tick time graph, players and log](docs/screenshots/server-overview-dark.png)

<sub>Screenshots use demo data (a real Paper 1.21.8 server with three bot players).</sub>

<details>
<summary><strong>More screenshots</strong></summary>

| | |
|---|---|
| ![Dashboard, dark](docs/screenshots/dashboard-dark.png)<br>Dashboard (dark), with quota bars | ![Dashboard, light](docs/screenshots/dashboard-light.png)<br>Dashboard (light) |
| ![Create server, loader version picker](docs/screenshots/wizard-version-loader-dropdown.png)<br>Create-server wizard: searchable loader version | ![Create server, Minecraft config](docs/screenshots/wizard-minecraft-config.png)<br>Wizard: initial Minecraft configuration |
| ![Console](docs/screenshots/server-console.png)<br>Console | ![File editor](docs/screenshots/server-files-editor.png)<br>File manager and editor |
| ![Backups](docs/screenshots/server-backups.png)<br>Backups (manual and scheduled) | ![Sharing](docs/screenshots/server-sharing.png)<br>Sharing with viewer / operator / manager levels |
| ![Admin users and quotas](docs/screenshots/admin-users.png)<br>Admin: users and quotas | ![Admin settings](docs/screenshots/admin-settings.png)<br>Admin: port pool and CurseForge key |
| ![Audit log](docs/screenshots/admin-audit.png)<br>Admin: audit log | ![Updates](docs/screenshots/admin-updates.png)<br>Admin: updates (no release published yet) |
| ![Account security](docs/screenshots/account-security.png)<br>Account: authenticator app, passkeys, API tokens | ![Login](docs/screenshots/login-dark.png)<br>Sign-in |
| ![Spanish UI](docs/screenshots/dashboard-spanish.png)<br>Spanish interface | ![Mobile dashboard](docs/screenshots/mobile-dashboard.png) ![Mobile overview](docs/screenshots/mobile-overview.png)<br>Mobile (390x844) |

</details>

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start with Docker](#quick-start-with-docker)
- [Install on Proxmox (LXC)](#install-on-proxmox-lxc)
- [LAN discovery](#lan-discovery)
- [Configuration](#configuration)
- [First login](#first-login)
- [Updating](#updating)
- [CurseForge API key](#curseforge-api-key)
- [Security notes](#security-notes)
- [Development](#development)
- [Project layout](#project-layout)
- [Known limitations](#known-limitations)
- [Roadmap ideas](#roadmap-ideas)
- [License](#license)

## Features

**Servers and types**
- Java: Vanilla, Paper, Purpur, Folia, Fabric, Quilt, Forge and NeoForge; Bedrock Edition as well.
- Modpacks straight from Modrinth or CurseForge (itzg `MODRINTH` / `AUTO_CURSEFORGE`).
- Create-server wizard: type, Minecraft version, searchable loader version, resources, and an initial Minecraft configuration (game mode, difficulty, MOTD, whitelist, ops, seed, resource pack and more) applied on the first start.
- Optional LAN discovery for Java servers: players on the same network see them under "Scanning for games on your local network".
- Server templates, and one-click clone.
- Import and export: CurseForge manifest zip, Modrinth `.mrpack` and server-pack zip.

**Live monitoring** (modelled on the vanilla server window)
- Memory bar, average tick time graph, TPS and p95 tick, CPU, uptime, disk, players list with heads, and a live log with a command box.
- Java servers are read over RCON plus Docker stats; crashes are detected and servers can auto-restart with backoff.

**Operations**
- Web console, file manager with a text editor, `server.properties` editor.
- Backups: manual, scheduled, retention, restore, download.
- Cron schedules: restart, command, backup, start, stop.
- Webhooks (Discord or generic) for start/stop/crash, player join/leave, backups and more.
- Mods and plugins browser (Modrinth, CurseForge, Hangar for Paper-family servers) with dependency install and update check.
- Players: whitelist, ops, kick, ban, pardon (live over RCON, or by editing the JSON files when the server is stopped).

**Users and security**
- Roles (admin, user), per-user quotas (servers, RAM, CPU, disk), and per-server sharing as viewer, operator or manager.
- Two-factor authentication with TOTP and passkeys (WebAuthn).
- Game port pool managed by the admin.
- Audit log and personal API tokens (`Authorization: Bearer scf_...`).

**Platform**
- Installable PWA, light/dark/system theme, English and Spanish.
- Self-update from GitHub releases (LXC / source installs) with verification and rollback; update notice for Docker installs.

## How it works

```mermaid
flowchart LR
    B["Browser / PWA"] -- "HTTPS (REST + WebSocket /ws)" --> A
    subgraph SC["ServCrafty container or LXC"]
        A["Fastify API + static web UI"]
        D["Docker daemon<br/>(bundled dockerd / DinD)"]
        subgraph G["Game containers (itzg images)"]
            M1["minecraft-server"]
            M2["minecraft-bedrock-server"]
        end
        A -- "dockerode" --> D
        D --> G
        A -- "RCON, docker stats, log stream" --> G
    end
    A -- "SQL" --> P[("PostgreSQL<br/>(external)")]
    A -. "catalog APIs" .-> C["Modrinth / CurseForge / Hangar / Mojang"]
    P1["Players"] -- "game port pool (e.g. 25565-25600)" --> G
```

- The server is a single Fastify process written in TypeScript. It serves the React web app, the REST API under `/api` and a WebSocket at `/ws` for logs and stats.
- State (users, servers, shares, backups metadata, schedules, audit) lives in an external PostgreSQL database. Migrations in `server/migrations/*.sql` run at boot.
- Game servers are sibling containers (`itzg/minecraft-server`, `itzg/minecraft-bedrock-server`) created through the Docker API. In the Docker image the daemon is bundled (Docker-in-Docker); on LXC it is the container's own Docker.
- Each game server gets one host port from the pool. RCON stays on the internal Docker network.
- World data is bind-mounted from `DATA_DIR/servers/<id>`; backups go to `DATA_DIR/backups/<id>`.

## Requirements

- An external **PostgreSQL** database (any recent version) reachable from ServCrafty. ServCrafty does not ship one.
- Either:
  - **Docker** with permission to run a `--privileged` container (the bundled Docker daemon needs it), or
  - a **Proxmox VE** host to create a privileged, nesting-enabled LXC with the installer script.
- Outbound internet access for pulling the itzg images, Minecraft/loader downloads and the catalog APIs.
- Plan RAM for the servers you want to run: the panel itself is light, a Minecraft server is not.

## Quick start with Docker

1. Create an empty PostgreSQL database and user.
2. Create a `.env` next to `docker-compose.yml` (start from `.env.example`):

   ```env
   DATABASE_URL=postgres://servcrafty:CHANGE_ME@db.example.lan:5432/servcrafty
   SECRET_KEY=<at least 32 random characters>
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=<choose a strong password>
   PUBLIC_URL=https://servcrafty.example.com
   ```

   Special characters in the database password must be URL-encoded (`@` becomes `%40`).
   `SECRET_KEY` also encrypts stored secrets (such as the CurseForge key). Keep it stable and backed up.

3. Start it:

   ```bash
   docker compose up -d --build     # builds the image locally from this repository
   ```

   `docker-compose.yml` points at `ghcr.io/joaquincabrerasimoes/servcrafty:${SERVCRAFTY_TAG:-latest}`, which is published by the release workflow. No release has been published yet, so for now use `--build` (the `build: .` fallback). Once a release exists you can use `docker compose pull && docker compose up -d`, and pin a version with `SERVCRAFTY_TAG=0.2.0`.

4. Open `http://<host>:8080` and sign in with the admin credentials.

Notes:

- The container **must run privileged** (`privileged: true` in the compose file, or `docker run --privileged`). It starts its own `dockerd` and stores game-server images and containers in the `servcrafty-docker` volume; data and backups are in the `servcrafty-data` volume.
- Ports: `8080` is the web UI. `25565-25600` is the game port pool; the compose file publishes that range, so keep **Admin > Settings > Game port pool** inside it (or change both).
- **Reverse proxy / Cloudflare:** terminate HTTPS in front of port 8080 and forward WebSockets. Set `TRUST_PROXY=1` (the compose file defaults to it) so the real client IP and `https` are used (the session cookie is only marked `Secure` when the request is HTTPS). Set `PUBLIC_URL` to the exact public address. Game traffic is plain TCP/UDP and does not go through an HTTP proxy such as Cloudflare's orange cloud; forward the game ports directly.
- **Passkeys** need a real HTTPS domain (or `localhost`); `PUBLIC_URL` is used as the WebAuthn origin and relying-party ID.
- The compose file's default `PUBLIC_URL` is the author's own domain; always set yours.
- To use a Docker daemon you already run instead of the bundled one, the entrypoint honours `EXTERNAL_DOCKER=1` (you then provide `DOCKER_HOST` and the data path mapping yourself; this setup is not covered further here).

## Install on Proxmox (LXC)

Run on the **Proxmox host** as root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/joaquincabrerasimoes/ServCrafty/main/lxc/servcrafty-lxc.sh)"
```

> **Proxmox version matters.** Docker 29 / runc 1.3+ cannot start containers inside an LXC on older Proxmox releases: every game server fails with
> `open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: permission denied`. This was reproduced on Proxmox VE 9.0.5 (LXC 6.0.4) and
> fixed after upgrading the host to LXC 7.0.0 / pve-container 6.1.x (Proxmox VE 9.1 or newer), then restarting the CT with `pct stop` + `pct start`
> (`pct reboot` is not enough). The installer warns when it detects an LXC older than 7. See the
> [Proxmox forum thread](https://forum.proxmox.com/threads/docker-inside-lxc-net-ipv4-ip_unprivileged_port_start-error.175437/).

The script asks for:

1. PostgreSQL URL (`postgres://user:pass@host:5432/db`)
2. Admin username (default `admin`) and password
3. Public URL (the default shown in the prompt is the author's domain; enter yours)

It then:

- downloads the latest Debian 12 template and creates a **privileged** CT with `nesting=1,keyctl=1` and start-on-boot;
- installs Docker, Node.js 22 and git, clones this repository to `/opt/servcrafty`, and builds the web and server;
- writes `/etc/servcrafty/env` (mode 600, with a generated `SECRET_KEY`, `TRUST_PROXY=1`, `INSTALL_TYPE=lxc`) and a `servcrafty` systemd service;
- prints the URL of the panel (`http://<CT IP>:8080`).

Defaults can be overridden with environment variables before running it: `CTID`, `HOSTNAME_CT`, `CORES` (4), `RAM` in MB (8192), `DISK` in GB (40), `STORAGE` (`local-lvm`), `TEMPLATE_STORAGE` (`local`), `BRIDGE` (`vmbr0`), `IPCFG` (`dhcp`, or e.g. `192.168.1.50/24,gw=192.168.1.1`), `REPO_URL`, and `GITHUB_TOKEN` (only needed for a private fork).

Caveat: the CT is **privileged** with nesting, which is a weaker isolation boundary than an unprivileged CT. Put it on a host and network you trust.

Useful commands on the Proxmox host:

```bash
pct enter <CTID>                      # get a shell in the container
pct exec <CTID> -- systemctl status servcrafty
pct exec <CTID> -- journalctl -u servcrafty -f
```

Inside the CT the app is in `/opt/servcrafty`, configuration in `/etc/servcrafty/env` and data in `/data`.

## LAN discovery

Minecraft Java clients list "LAN World" entries from UDP multicast packets sent to `224.0.2.60:4445` about every 1.5 seconds (the payload is `[MOTD]name[/MOTD][AD]port[/AD]`). Dedicated servers never send them, so ServCrafty can do it on their behalf.

- Turn on **Show on the local network** for a Java server (in the create wizard's Minecraft step, or later in the server's Settings). It is off by default.
- While the server is **running**, ServCrafty announces it from every usable IPv4 interface of the machine it runs on (loopback, link-local, Docker bridges and veth interfaces are skipped). The listed name is the server's MOTD if one is set, otherwise the server name; the port is the server's game port.
- Players on the same network then see it in the Multiplayer screen, under "Scanning for games on your local network". Announcing stops when the server stops, crashes, is deleted or the toggle is turned off.
- `LAN_ANNOUNCE=0` disables the feature; `LAN_ANNOUNCE_INTERFACES=192.168.1.10` restricts it to specific addresses.

Caveats:
- ServCrafty must sit directly on the players' network. That is the case for the **Proxmox LXC** install (bridged to your LAN) and for Docker with **host networking** (`network_mode: host`). With the default Docker bridge network the packets leave from the container's private address and never reach the LAN.
- Multicast has to reach the clients: some Wi-Fi access points, managed switches with IGMP snooping and firewalls block or filter `224.0.2.60`. Allow outbound UDP to `224.0.2.60:4445` and multicast on the VLAN.
- It only works within one broadcast domain (no routing across subnets or VPNs).
- **Bedrock** servers are not supported yet; the option is hidden for them and the API rejects it.

## Configuration

Set these as environment variables (a `.env` for Docker Compose, `/etc/servcrafty/env` on LXC). Only `DATABASE_URL` and `SECRET_KEY` are required.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string. URL-encode special characters in the password. |
| `SECRET_KEY` | required, 32+ chars | Signs session cookies and encrypts stored secrets (AES-256-GCM). |
| `ADMIN_USERNAME` | `admin` | Admin created on first boot, only if the users table is empty. |
| `ADMIN_PASSWORD` | none | Password for that admin. |
| `ADMIN_EMAIL` | none | Optional email for that admin. |
| `PUBLIC_URL` | `http://localhost:8080` | Public address of the panel. Used as the WebAuthn (passkey) origin and RP ID. |
| `PORT` | `8080` | HTTP port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `NODE_ENV` | `development` | The Docker image and LXC installer set `production`. |
| `DATA_DIR` | `/data` | World data (`servers/`), backups (`backups/`) and temp files. |
| `HOST_DATA_DIR` | same as `DATA_DIR` | Path of `DATA_DIR` as the Docker daemon sees it. Only differs if the daemon is not in the same filesystem namespace. |
| `DOCKER_HOST` | `unix:///var/run/docker.sock` | Docker endpoint. On Windows with Docker Desktop: `npipe:////./pipe/docker_engine`. |
| `DOCKER_NETWORK` | `servcrafty` | Docker network the game containers join. |
| `PORT_POOL_DEFAULT` | `25565-25600` | Initial game port pool (afterwards edit it in Admin > Settings). |
| `CURSEFORGE_API_KEY` | none | Seeds the encrypted CurseForge key in settings. See [below](#curseforge-api-key). |
| `TRUST_PROXY` | off | `1` or `true` when behind a reverse proxy / Cloudflare. |
| `WEB_DIST` | `../web/dist` | Directory with the built web app. |
| `LOG_LEVEL` | `info` | Fastify/pino log level. |
| `RCON_PUBLISH_LOCAL` | off | Development aid for Docker Desktop: also publish RCON on `127.0.0.1:<random>` and use it. |
| `ALLOW_PRIVATE_WEBHOOKS` | off | `1` allows webhooks to target loopback / private-network addresses (disables part of the SSRF protection). |
| `UPDATE_REPO` | `joaquincabrerasimoes/ServCrafty` | GitHub `owner/name` checked for releases. |
| `UPDATE_CHECK` | on | `0`, `false`, `off` or `no` disables all update-check network calls. |
| `LAN_ANNOUNCE` | on | `0`, `false`, `off` or `no` disables the LAN discovery announcer entirely (see [LAN discovery](#lan-discovery)). |
| `LAN_ANNOUNCE_INTERFACES` | all usable | Optional comma list of local IPv4 addresses the announcer sends from, e.g. `192.168.1.10`. |
| `INSTALL_TYPE` | auto | `docker`, `lxc` or `source`. Set by the image and the LXC installer; otherwise a `.git` directory means `lxc`, else `source`. |
| `GITHUB_TOKEN` | none | Optional token to raise the GitHub API rate limit for update checks. |
| `EXTERNAL_DOCKER` | `0` | Docker image only: `1` skips starting the bundled `dockerd`. |
| `SERVCRAFTY_TAG` | `latest` | Docker Compose only: image tag to run. |

Other settings (port pool, public URL, CurseForge key, default Java arguments) are edited at runtime in **Admin > Settings**.

## First login

On the first boot with an empty users table, ServCrafty creates the admin from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. There is no public sign-up; the admin creates other users in **Admin > Users** and can give them quotas. After the first login you can remove `ADMIN_PASSWORD` from the environment (it is only read while no user exists), then change your password and enable TOTP or a passkey under **Account**.

If you lose the admin's second factor, another admin can reset it from Admin > Users. There is no such recovery path for the only admin; keep a second admin account.

## Updating

**LXC and source installs:** open **Admin > Updates**. ServCrafty checks stable GitHub releases (`vX.Y.Z` tags only; drafts and prereleases are ignored), shows the notes, and offers an **Update** button. Before updating it verifies that the tag's commit matches what GitHub reports, then builds the new version, restarts the service and waits for a healthy `/api/health`. If anything fails it rolls back automatically, and you can roll back manually afterwards. The panel is down for roughly 30 seconds; running game servers are separate containers and keep running. The button needs root, `git`, `systemd-run` and `systemctl`; otherwise the page explains what is missing. `lxc/update.sh` remains as a manual fallback that follows `main`.

**Docker installs:** the page only notifies you. Update with:

```bash
docker compose pull && docker compose up -d
```

**Database migrations are forward-only.** A rollback restores the previous code, not the database schema; migrations are meant to be additive, but take a database backup before major upgrades.

**Cutting a release (maintainers):**

```bash
scripts/release.sh patch        # or minor | major | X.Y.Z[-pre]
git push origin main vX.Y.Z     # the script prints the exact command
```

The script bumps the version in the root, `server/` and `web/` `package.json` (and lockfiles), commits `Release vX.Y.Z` and creates an annotated tag; it does not push. Pushing the tag runs `.github/workflows/release.yml`, which checks that the tag matches `server/package.json`, builds and pushes `ghcr.io/<owner>/servcrafty:<version>` (linux/amd64, plus `:latest` for stable tags) and creates the GitHub release with generated notes (marked as prerelease if the tag has a `-` suffix).

## CurseForge API key

Modrinth and Hangar work without a key. CurseForge search, modpacks and mod installs need an API key from the [CurseForge console](https://console.curseforge.com/). Either put it in `CURSEFORGE_API_KEY` (it is stored encrypted on first boot) or paste it in **Admin > Settings**. The key is never returned by the API; the UI only shows whether one is set.

## Security notes

- **Privileged container.** The Docker image runs its own `dockerd`, which requires `--privileged`; the LXC is privileged with nesting. Anyone who can create servers can influence what runs in the game containers, so treat panel users as semi-trusted and keep the panel patched.
- **Secrets** come from the environment and are never committed; `.env` is git-ignored. Stored secrets (CurseForge key, TOTP secrets) are encrypted with a key derived from `SECRET_KEY`. Changing `SECRET_KEY` makes them unreadable.
- **Passwords** are hashed with argon2id. Login and 2FA attempts are rate limited.
- **Sessions** use a signed, `httpOnly`, `SameSite=Lax` cookie (`scf_sid`) with a 30-day lifetime; a half-finished login (password accepted, 2FA pending) lasts 10 minutes. The cookie is `Secure` when the request arrives over HTTPS, which behind a proxy requires `TRUST_PROXY=1`.
- **TOTP replay protection:** the last accepted 30-second step is stored per user, so a code cannot be used twice.
- **SSRF protection for webhooks:** loopback, private, link-local and similar addresses are rejected when a webhook is saved and again on delivery, and redirects are not followed. `ALLOW_PRIVATE_WEBHOOKS=1` relaxes this.
- **File access** is confined to each server's directory (path-traversal safe); downloads from the catalogs are verified against published hashes where the source provides them.
- Put the panel behind HTTPS. Do not expose the Docker socket or the PostgreSQL database to the internet.

## Development

Requires Node.js 22+, npm, Docker, and a PostgreSQL database.

```bash
git clone https://github.com/joaquincabrerasimoes/ServCrafty.git
cd ServCrafty
npm install                 # installs both workspaces
cp .env.example .env        # then edit; use a separate dev database, e.g. servcrafty_dev
npm run dev:server          # API on :8080, loads ../.env, restarts on change
npm run dev:web             # Vite on :5173, proxies /api and /ws to :8080
```

- For the dev server, set `PUBLIC_URL=http://localhost:5173` (so passkeys work against the Vite origin) and `DATA_DIR=./data`.
- On Windows or macOS with Docker Desktop also set `DOCKER_HOST=npipe:////./pipe/docker_engine` (Windows) and `RCON_PUBLISH_LOCAL=1`, since container IPs are not routable from the host.
- To point the Vite proxy at a different backend, set `SERVCRAFTY_BACKEND=http://localhost:PORT` when running the web dev server.

Other commands:

```bash
npm test --workspace server        # node:test unit tests (upstream APIs are mocked)
npm run typecheck --workspace server
npm run typecheck --workspace web
npm run build                      # web, then server
npm start                          # run the built server (serves web/dist)
npm run migrate --workspace server # apply migrations only
```

Build the container image locally with `docker build -t servcrafty .`. The technical contract (API, data model, stats payload) is in [SPEC.md](SPEC.md); implementation notes beyond the spec are in [server/README.md](server/README.md).

## Project layout

```
server/            Fastify + TypeScript backend (ESM)
  src/routes/      REST modules and the /ws WebSocket
  src/services/    Docker orchestration, RCON, stats, backups, scheduler, webhooks,
                   mods, players, modpack import/export, updater
  src/auth/        sessions, argon2id, TOTP, WebAuthn
  src/catalog/     Modrinth, CurseForge, Hangar clients; Minecraft and loader versions
  migrations/      plain SQL, applied at boot
  test/            unit tests
web/               React + Vite + Tailwind PWA (src/pages, src/components, src/i18n)
docker/            entrypoint for the bundled dockerd
lxc/               Proxmox installer, manual update script, self-update apply script
scripts/           release.sh
docs/screenshots/  images used in this README
Dockerfile, docker-compose.yml, SPEC.md
```

## Known limitations

- **Docker inside LXC needs a recent Proxmox** (LXC 7.x, Proxmox VE 9.1+); see the note in *Install on Proxmox*.
- The **disk limit is soft**: it is checked on file writes and uploads and by the stats poller (which can raise a `disk.exceeded` webhook), but Docker does not enforce it.
- **Bedrock** servers have no RCON: no TPS or tick-time graph, and the player list comes from log lines. Memory and CPU still come from Docker stats. Commands go through the itzg `send-command` helper and their output shows up in the log.
- **LAN discovery** is Java only and needs the host on the players' network (see [LAN discovery](#lan-discovery)).
- **Hangar** is plugin-only and available for Paper, Purpur and Folia servers.
- **CurseForge** needs your own API key, and some files have no download URL in the API (authors can disable third-party distribution) and cannot be installed; such dependencies are reported as skipped.
- Only **linux/amd64** images are built by the release workflow.
- Passkeys were exercised only with software authenticators (`server/test/passkeys.e2e.ts`, which runs against a live server and is not part of `npm test`, and a browser virtual authenticator); they have not been tried on real phones or hardware keys.
- Not tested end to end yet: the **CurseForge live API** (no key was used during development), the **Proxmox installer on a real host**, and the **self-update on a published release** (no release exists yet).

## Roadmap ideas

Not promised, just on the list:

- S3-compatible backup storage
- A TCP/UDP router (mc-router style) so many servers can share one public port
- Historical resource graphs
- Prometheus metrics endpoint
- Dynmap integration
- Discord chat bridge

## License

No license has been chosen yet; all rights reserved by the author unless stated otherwise.
