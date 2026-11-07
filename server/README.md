# ServCrafty server

Fastify + TypeScript (ESM) backend. The contract is `../SPEC.md`; this file covers running it and the places where it goes beyond the spec.

## Run

```bash
cd server
npm install --workspaces=false     # or `npm install` at the repo root (workspaces)
npm run typecheck                  # tsc --noEmit
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

`HOST` (0.0.0.0), `LOG_LEVEL` (info), `TRUST_PROXY` (1 behind a reverse proxy), `WEB_DIST`, `RCON_PUBLISH_LOCAL`.

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

- **Containers.** Each start recreates `servcrafty-<id>` from the current config, so edits take effect on the next start. RestartPolicy is `no`; ServCrafty watches docker `die` events.
  - Exit code 0 or 143, or a stop it requested, counts as a normal stop. Anything else marks the server `crashed`.
  - With `autoRestart`, a crashed server restarts with backoff (5 s × the crash count), at most 3 times in 10 minutes.
  - The panel's own shutdown leaves game containers running.
- **Image.** `itzg/minecraft-server`. The tag follows the MC version: `java8` up to 1.16, `java17` up to 1.20.4, `latest` after that. Override it with the server env key `SERVCRAFTY_IMAGE_TAG`. Bedrock uses `itzg/minecraft-bedrock-server`.
- **Memory.** `memoryMb` is the JVM heap (`MEMORY`). The container limit adds max(384 MB, 20 %) of overhead. Quotas count `memoryMb`.
- **`cpuPercent`** in stats is a percentage of the server's allotted cores: 100 means every allotted core is busy.
- **Disk limit** (`diskMb`) is soft. It is checked by file writes and uploads (HTTP 507) and by the stats poller, which raises the `disk.exceeded` webhook. Docker does not enforce it.
- **Commands.** Java servers take commands over RCON (its own client in `services/rcon.ts`). Bedrock servers go through itzg's `send-command` via `docker exec`.
- **Player actions on a stopped server** edit `ops.json`, `whitelist.json` and `banned-players.json` directly. UUIDs come from Mojang, or are the offline UUID when `online-mode=false`.
- **Modrinth required dependencies** are installed automatically with a mod.
- **Export.** `serverpack` leaves out `logs`, `libraries`, `versions` and similar caches. It also leaves out the world unless `?includeWorld=true` is passed. The pack carries a `servcrafty.json` so it can be imported again. Mods that Modrinth or CurseForge don't recognise go into `overrides/mods`. Warnings come back in the `X-ServCrafty-Warnings` header.

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
| Player actions | `{applied:"live"\|"file", output}` |
