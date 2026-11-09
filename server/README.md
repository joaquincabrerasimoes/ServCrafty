# ServCrafty server

Fastify + TypeScript (ESM) backend. The contract is `../SPEC.md`; this file covers running it and the places where it goes beyond the spec.

## Run

```bash
cd server
npm install --workspaces=false     # or `npm install` at the repo root (workspaces)
npm run typecheck                  # tsc --noEmit
npm test                           # node:test unit tests (mocked upstream APIs)
npm run dev                        # tsx watch, loads ../.env if present
npm run build && npm start         # production (dist/index.js)
npm run migrate                    # apply migrations only
```

When it boots, the server:

1. Applies `migrations/*.sql` and records them in `schema_migrations`. An advisory lock keeps two instances from migrating at once.
2. Seeds settings (`port_pool` from `PORT_POOL_DEFAULT`, and the encrypted CurseForge key from `CURSEFORGE_API_KEY`).
3. Creates the admin from `ADMIN_USERNAME`/`ADMIN_PASSWORD` if the users table is empty.
4. Reconciles containers with the DB and re-attaches log and stats streams.
5. Registers cron schedules.
6. Starts listening on `PORT`.

It serves `../web/dist` (or `WEB_DIST`) with an SPA fallback. The API is under `/api`, the WebSocket at `/ws`, and the health check at `/api/health`.

### Running on Windows or macOS (Docker Desktop)

```
DOCKER_HOST=npipe:////./pipe/docker_engine   # Windows
RCON_PUBLISH_LOCAL=1                          # container IPs aren't routable from the host
```

`RCON_PUBLISH_LOCAL=1` also publishes RCON on `127.0.0.1:<random>`. In production (bundled dockerd), RCON is reached through the container IP on `DOCKER_NETWORK`.

### Extra env vars (beyond the spec)

`HOST` (0.0.0.0), `LOG_LEVEL` (info), `GITHUB_TOKEN` (optional, update checks), `TRUST_PROXY` (1 behind a reverse proxy), `WEB_DIST`, `RCON_PUBLISH_LOCAL`, `ALLOW_PRIVATE_WEBHOOKS`, `LAN_ANNOUNCE` (`0`/`false`/`off`/`no` disables the LAN discovery announcer), `LAN_ANNOUNCE_INTERFACES` (optional comma list of local IPv4 addresses to send from; default: every non-internal, non-link-local, non-virtual interface).

`ALLOW_PRIVATE_WEBHOOKS=1` lets webhooks target loopback, private (RFC 1918), link-local and other non-public addresses. By default these are rejected when a webhook is saved and again at delivery (SSRF protection); redirects are never followed. Turn it on only if you notify services on your own LAN.

## Layout

```
src/
  index.ts            boot / shutdown
  app.ts              Fastify setup, error shape, static SPA
  config.ts           env validation (zod)
  db/                 pg pool, migration runner
  auth/               sessions (signed cookie), argon2id, TOTP, WebAuthn, request auth hook
  lib/                errors, validation, safe paths, zip, properties, ports, http
  catalog/            Modrinth / CurseForge clients, MC + loader version lists
  services/           runtime (docker orchestration, logs, RCON, stats, crash handling),
                      servers, files, backups, scheduler, webhooks, mods, players,
                      modpack (export/import), templates, access, users, settings, audit
  routes/             one module per REST area + ws.ts
migrations/001_init.sql
```

## Behaviour notes

- **LAN discovery** (`services/lanAnnouncer.ts`). Per-server `lan_announce` flag (migration 004; `lanAnnounce` in the API, PATCH needs manager; rejected with 400 `lan_announce_unsupported` for Bedrock). One 1.5 s timer sends `[MOTD]<name>[/MOTD][AD]<port>[/AD]` to `224.0.2.60:4445` from one UDP socket per usable IPv4 interface (re-enumerated every 30 s) for every running Java server with the flag on. The name is the sanitised `minecraft.motd`, falling back to the server name. It re-evaluates on every runtime status event and on create/update/delete. Send errors are logged once per interface and error.

- **Containers.** Each start recreates `servcrafty-<id>` from the current config, so edits take effect on the next start. RestartPolicy is `no`; ServCrafty watches docker `die` events.
  - Exit code 0 or 143, or a stop it requested, counts as a normal stop. Anything else marks the server `crashed`.
  - With `autoRestart`, a crashed server restarts with backoff (5 s × the crash count), at most 3 times in 10 minutes.
  - The panel's own shutdown leaves game containers running.
- **Image.** `itzg/minecraft-server`. The tag follows the MC version: `java8` up to 1.16, `java17` up to 1.20.4, `latest` after that. Override it with the server env key `SERVCRAFTY_IMAGE_TAG`. Bedrock uses `itzg/minecraft-bedrock-server`.
- **Memory.** `memoryMb` is the JVM heap (`MEMORY`). The container limit adds max(512 MB, 25 %) of overhead (a fully used 2 GB Paper heap measured ~2.4 GB resident). Quotas count `memoryMb`.
- **`cpuPercent`** in stats is a percentage of the server's allotted cores: 100 means every allotted core is busy.
- **Disk limit** (`diskMb`) is soft. It is checked by file writes and uploads (HTTP 507) and by the stats poller, which raises the `disk.exceeded` webhook. Docker does not enforce it.
- **Commands.** Java servers take commands over RCON (its own client in `services/rcon.ts`). Bedrock servers go through itzg's `send-command` via `docker exec`.
- **Player actions on a stopped server** edit `ops.json`, `whitelist.json` and `banned-players.json` directly. UUIDs come from Mojang, or are the offline UUID when `online-mode=false`.
- **Required dependencies** are installed automatically with a mod or plugin (Modrinth `required`, CurseForge `relationType 3`, Hangar required plugin dependencies). A dependency that cannot be fetched is listed in the `skipped` field of the install response instead of failing the install.
- **Hangar** (`source=hangar`) is a plugin-only source for Paper, Purpur and Folia servers (`/catalog/*` and `/servers/:id/mods/install`). Projects are identified by slug and versions by version name; downloads are verified with the sha256 Hangar publishes.
- **Webhook test** makes one 5 s attempt and reports the network cause (refused, unresolved, timed out, TLS). Real deliveries still retry 3 times.
- **Stats `version`** is the Minecraft version; `packName`/`packVersion` describe the modpack.
- **TOTP replay.** The last accepted 30 s time step is stored per user (`users.totp_last_step`); a code at or before it is rejected, so a code cannot be used twice.
- **Export.** `serverpack` leaves out `logs`, `libraries`, `versions` and similar caches. It also leaves out the world unless `?includeWorld=true` is passed. The pack carries a `servcrafty.json` so it can be imported again. Mods that Modrinth or CurseForge don't recognise go into `overrides/mods`. Warnings come back in the `X-ServCrafty-Warnings` header.

## Self-update and releases

The contract is SPEC "Self-update feature (v0.2)". The code is in `src/services/updater.ts`, `src/routes/update.ts` (`/api/admin/update*`, admin only) and `lxc/apply-update.sh`.

**Env:** `UPDATE_REPO` (`joaquincabrerasimoes/ServCrafty`), `UPDATE_CHECK` (`0` turns off all GitHub calls), `INSTALL_TYPE` (`docker` in the image, `lxc` from the LXC installer; when unset, a `.git` in the app root means `lxc`, otherwise `source`), `GITHUB_TOKEN` (optional).

**Checks.**
- The check reads `GET /repos/<repo>/releases?per_page=30`. Drafts, prereleases and any tag that is not a plain `vX.Y.Z` are dropped, and the highest remaining version wins. That tag is then resolved to its commit through `git/ref/tags/<tag>` (following annotated tags) and `commits/<sha>`. `verified` is GitHub's signature verification of the tag object or of the commit.
- Results are cached for 6 h. Requests send `If-None-Match`, and the ETag cache is kept in `$DATA_DIR/update/check-cache.json` so it survives a restart. When the release list comes back `304`, the resolved commit is reused. This matters because unauthenticated 304s still count against GitHub's 60 req/h limit.
- When `x-ratelimit-remaining` reaches 0, requests stop until the reset time. A failed check is retried after 15 minutes at the earliest.
- Network errors only set `checkError`. They are never thrown.
- `POST /admin/update/check` is limited to 6 per 10 minutes per admin.
- With no releases, the payload has `latest: null` and `checkError: null`.

**`canUpdate`** requires all of:
- install type `lxc` or `source`
- a `.git` directory and `git` on PATH
- `systemd-run` and `systemctl`
- running as root
- a writable app root

`cannotUpdateReason` gives the first one that fails.

**Apply.**
- `POST /admin/update/apply {version?}` takes the cached latest release, re-checking first if the cache is older than 10 min. `version` may name another stable release, but it must be newer than the running version. Downgrades go through rollback.
- The server copies `lxc/apply-update.sh` to `$DATA_DIR/update/` and writes `status.json` as `running/starting`. It then runs `systemd-run --unit=servcrafty-updater --collect --no-block --setenv=UPDATE_REPO=… --setenv=PORT=… --setenv=PATH=… --setenv=HOME=… bash <copy> <tag> <sha> <appRoot> <dataDir>`.
- If a `running` status is older than 2 min and the unit is no longer active, it is reported as `failed`.
- The version and commit are read once at startup. During an update, `/api/health` therefore reports the version that is actually running.

**`apply-update.sh`** (bash, shellcheck-clean, runs outside the service cgroup):
- **verify:** `remote.origin.url` must be `https://github.com/<UPDATE_REPO>(.git)`. Credentials in the URL are accepted and masked in messages. The script then runs `git fetch --tags --force origin` and checks that the tag exists and that `rev-parse <tag>^{commit}` equals the SHA from GitHub. It refuses to run if tracked files are modified (`package-lock.json` changes that `npm install` regenerated are discarded first).
- **backup:** the current SHA and version go to `previous.json`, and `server/dist` and `web/dist` are copied to `prev/`.
- **checkout:** `git checkout --detach <tag>`. The script also checks that `server/package.json` reports the expected version.
- **install, build:** `npm install … --include=dev`, then the web and server builds.
- **restart, health:** `systemctl restart servcrafty`, then it waits up to 120 s for `/api/health` to show `ok:true` and the target `version`.
- **Automatic rollback:** any failure after the backup starts triggers it. The script checks out the previous SHA, runs `npm install`, restores the saved dist (or rebuilds if it is missing), restores the earlier `previous.json`/`prev/`, restarts and waits for a healthy panel. The final state is `rolled_back`, or `failed` if the rollback itself had problems.
- **`--rollback`:** takes the same path to the commit in `previous.json`. It reuses that version's saved build instead of rebuilding, and afterwards `previous.json` points at the version you came from.
- **Logging and locking:** every step is written to `status.json` and appended to `update.log`. A `flock` on `update/lock` stops two updaters from running at once.
- **Database:** migrations are forward-only. A rollback does not revert them.
- **Test overrides:** `SERVICE_NAME`, `HEALTH_TIMEOUT`, `HEALTH_URL` and `UPDATE_RESTART_CMD`.

`lxc/update.sh` is still there as a manual fallback that follows `main`.

**Docker installs** only get a notification. The payload carries `dockerCommand: "docker compose pull && docker compose up -d"`, and the compose file uses `ghcr.io/joaquincabrerasimoes/servcrafty:${SERVCRAFTY_TAG:-latest}`, falling back to `build: .`.

**Releasing.**
1. Run `scripts/release.sh patch|minor|major|X.Y.Z[-pre]`. It bumps root/server/web `package.json` and the server/web lockfiles, commits `Release vX.Y.Z`, creates the annotated tag and prints the `git push` command. It does not push.
2. Pushing the tag runs `.github/workflows/release.yml`. The workflow checks that the tag matches `server/package.json`, then builds and pushes `ghcr.io/<owner>/servcrafty:<version>` (linux/amd64). It also pushes `:latest`, but only for stable tags.
3. The workflow then runs `gh release create --generate-notes --verify-tag` (with `--prerelease` when the tag has a `-` suffix). Prereleases are never offered by the updater.

### Endpoints added beyond the spec

- `POST /schedules/:id/run`
- `GET/POST /webhooks` (account-wide webhooks)
- `GET /webhooks/events`
- `PATCH /servers/:id/mods/:file {enabled}`
- `POST /servers/:id/mods/install` also takes `replace` (the old file to remove, for updates)
- `POST /templates`
- `GET /catalog/minecraft/loaders?type=&mcVersion=`
- `DELETE /users/:id?transferTo=<userId>`
- `GET /api/health`

### WebSocket extras

Besides the spec messages, the socket sends `{type:"command_result", serverId, command, output}` and answers `{type:"ping"}` with `{type:"pong"}`.

### Response shapes the spec does not fix

| Endpoint | Shape |
|---|---|
| `GET /servers/:id/logs` | `{lines: string[]}` |
| `GET /servers/:id/files` | `{path, entries:[{name,path,type,size,modifiedAt}]}` |
| `GET /servers/:id/mods` | `{kind:"mods"\|"plugins", mods:[{file,enabled,size,modifiedAt,meta}]}` |
| `GET /servers/:id/mods/updates` | `{updates:[...], checked, errors}` |
| `GET /catalog/search` | `{hits, total, offset, limit}` |
| `GET /catalog/minecraft/versions` | `{type, versions: string[], latest}` |
| `GET /admin/audit` | `{items, total}` |
| `GET /api/health` | `{ok, db, docker, version}` |
| Player actions | `{applied:"live"\|"file", output}` |
