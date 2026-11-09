# ServCrafty – Technical Spec (source of truth for backend + frontend)

Monorepo (npm workspaces): `server/` (Fastify + TypeScript, ESM), `web/` (React + Vite + TS + Tailwind, PWA), `docker/`, `lxc/`.
Production: the server serves `web/dist` statically and the API under `/api`; WebSockets under `/ws`.

## Decisions (from the owner – do not change)
- Stack: Node 22+/TypeScript, Fastify, React+Vite. DB: **PostgreSQL** (external; `DATABASE_URL`), via `pg` + plain SQL migrations (`server/migrations/*.sql`, applied at boot, tracked in `schema_migrations`). No ORM.
- Servers run as sibling containers inside a **bundled privileged dockerd** (DinD) in the ServCrafty container. Docker access via `dockerode` on `DOCKER_HOST` (default unix:///var/run/docker.sock). Images: `itzg/minecraft-server` (Java, all types, CurseForge/Modrinth modpacks) and `itzg/minecraft-bedrock-server` (Bedrock).
- Server types: VANILLA, PAPER, PURPUR, FOLIA, SPIGOT, BUKKIT (CraftBukkit), FABRIC, QUILT, FORGE, NEOFORGE, BEDROCK, plus modpack sources CURSEFORGE and MODRINTH (itzg `TYPE=AUTO_CURSEFORGE` / `MODRINTH`).
- Network: host port mapping from an admin-defined pool (one game port per server; RCON/query stay internal on the docker network).
- Auth: cookie session (httpOnly, SameSite=Lax, signed) ; password (argon2id via `@node-rs/argon2`); TOTP (`otplib`, QR via `qrcode`); Passkeys (`@simplewebauthn/server` + `/browser`). Passkeys and TOTP are 2nd factors (and passkeys can also be a passwordless login if the user enabled one – keep to: password -> then 2FA step if enrolled). Admin created from env `ADMIN_USERNAME`, `ADMIN_PASSWORD` (and optional `ADMIN_EMAIL`) on first boot if no users exist. No public signup; admin creates users.
- Roles: `admin`, `user`. Admin sees/manages ALL servers. User sees own + shared. Per-server share levels: `viewer` (view, console read, stats), `operator` (+ power, console commands, players, backups run), `manager` (+ files, settings, mods, delete backups, share). Owner/admin = full.
- Quotas per user (nullable = unlimited): `max_servers`, `max_ram_mb` (sum), `max_cpu` (sum of cores, decimal), `max_disk_mb` (sum). Enforced at create/update server.
- CurseForge API key: stored encrypted (AES-256-GCM, key from `SECRET_KEY` env) in `settings` table, editable by admin; env `CURSEFORGE_API_KEY` pre-seeds. Modrinth needs no key.
- Monitoring: hybrid. Source order: (1) optional companion agent (future, `agent` field reserved in stats payload); (2) RCON (`list`, and `tick query` for MSPT when supported) + Docker stats (mem/cpu) + log stream. Stats payload below.
- i18n: English + Spanish. Theme: light/dark/system.
- Features also required: backups (scheduled, retention, restore, download), web file manager + text editor, scheduled tasks (cron: restart/command/backup) + crash auto-restart, Discord/generic webhooks, mod/plugin browser (CurseForge/Modrinth/Hangar-optional) + update check, player management (whitelist/ops/bans via RCON/files), audit log + personal API tokens (Bearer), server templates + clone, modpack export/import (CurseForge manifest zip, Modrinth .mrpack, server pack zip).

## Config (env)
`PORT` (8080), `DATABASE_URL`, `SECRET_KEY` (required, >=32 chars), `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_EMAIL`, `PUBLIC_URL` (e.g. https://craft.example.com; used for WebAuthn rpID/origin), `DATA_DIR` (/data; server data under `/data/servers/<id>`, backups `/data/backups/<id>`), `DOCKER_HOST`, `DOCKER_NETWORK` (servcrafty), `CURSEFORGE_API_KEY`, `HOST_DATA_DIR` (path of DATA_DIR as seen by the docker daemon; default = DATA_DIR, since dockerd runs in same container), `PORT_POOL_DEFAULT` ("25565-25600").

## DB tables (migrations/001_init.sql)
users(id uuid pk, username unique, email, password_hash, role, locale, theme, disabled bool, max_servers, max_ram_mb, max_cpu numeric, max_disk_mb, totp_secret_enc, totp_enabled, created_at)
passkeys(id text pk (credentialID b64url), user_id, public_key bytea, counter bigint, transports text[], name, created_at, last_used_at)
api_tokens(id uuid, user_id, name, token_hash, prefix, created_at, last_used_at, expires_at)
sessions handled by signed cookie holding session id -> table sessions(id, user_id, expires_at, mfa_ok bool, user_agent, ip)
servers(id uuid, owner_id, name, type, mc_version, loader_version, modpack jsonb (source, project_id, file_id/version_id, name), java_args, memory_mb, cpu numeric, disk_mb, port int unique, env jsonb, minecraft jsonb (003: initial Minecraft config), container_id, status, auto_restart bool, created_at)
server_shares(server_id, user_id, level, pk(server_id,user_id))
settings(key pk, value jsonb, encrypted bool)   -- port_pool ("25565-25600" / list), curseforge_key, webhooks defaults, etc.
backups(id uuid, server_id, file, size_bytes, kind (manual|scheduled), created_by, created_at, note)
schedules(id uuid, server_id, cron, action (restart|command|backup|start|stop), payload, enabled, last_run_at)
webhooks(id uuid, server_id nullable, owner_id, url, kind (discord|generic), events text[], enabled)
audit_log(id bigserial, user_id, action, target_type, target_id, meta jsonb, ip, created_at)
templates(id uuid, owner_id, name, description, config jsonb, shared bool, created_at)

## REST API (all JSON, prefix /api, cookie session or `Authorization: Bearer scf_...`)
Error shape: `{ "error": { "code": "string", "message": "string" } }` with proper HTTP status.

Auth
- POST /auth/login {username,password} -> `{ status: "ok", user }` | `{ status:"mfa_required", methods:["totp","passkey"] }` (session created with mfa_ok=false)
- POST /auth/mfa/totp {code} -> `{status:"ok",user}`
- POST /auth/mfa/passkey/options -> WebAuthn authentication options ; POST /auth/mfa/passkey/verify {response} -> `{status:"ok",user}`
- POST /auth/logout ; GET /auth/me -> `{user, mfa:{totp:boolean, passkeys:number}}`
- POST /account/password {current,new}
- PATCH /account {email,locale,theme}
- POST /account/totp/setup -> `{secret, otpauthUrl, qrDataUrl}` ; POST /account/totp/enable {code} ; POST /account/totp/disable {password}
- POST /account/passkeys/options ; POST /account/passkeys/verify {response,name} ; GET /account/passkeys ; DELETE /account/passkeys/:id
- GET/POST /account/tokens ; DELETE /account/tokens/:id  (POST returns the plaintext token once)

Users (admin)
- GET /users ; POST /users {username,password,email,role,quotas} ; PATCH /users/:id (role, disabled, quotas, password reset, reset mfa) ; DELETE /users/:id
- GET /users/lookup?q= (any authenticated user; returns id+username only; for sharing)
- GET /account/quota -> `{limits:{...}, usage:{servers,ram_mb,cpu,disk_mb}}`

Admin settings
- GET/PUT /admin/settings -> `{ portPool: string ("25565-25600,25700"), curseforgeKeySet: boolean, curseforgeKey?: string(write only), defaultJavaArgs, publicUrl }`
- GET /admin/ports -> `[{port, serverId|null, serverName|null}]` ; GET /admin/audit?limit&offset&user&action ; GET /admin/system -> docker info, disk, versions

Servers (list filtered by access; admin all; response includes `access: "owner"|"admin"|"viewer"|"operator"|"manager"`)
- GET /servers ; POST /servers {name,type,mcVersion,loaderVersion?,modpack?,memoryMb,cpu,diskMb?,port? (auto from pool if omitted),env?{},autoRestart?,minecraft?{...},eula:true} ; GET /servers/:id ; PATCH /servers/:id ; DELETE /servers/:id
- `minecraft` (optional, zod-strict, see `server/src/lib/minecraftConfig.ts`): levelName, gameMode, forceGamemode, hardcore, difficulty, motd, maxPlayers, pvp, onlineMode, allowFlight, allowCheats (Bedrock), commandBlocks, allowNether, spawnAnimals/Monsters/Npcs, playerIdleTimeout, seed, levelType, generateStructures, generatorSettings, spawnProtection, maxWorldSize, whitelist{enabled,enforce,users[]}, ops[], viewDistance, simulationDistance, tickDistance (Bedrock), entityBroadcastRange, networkCompressionThreshold, resourcePack{url,sha1,required}, extra{key:value} (safe server.properties keys; ports/RCON/IP/management keys rejected). Options that do not exist on the edition -> 400 `invalid_minecraft_config`. Mapped to itzg env (Java: LEVEL, MODE, SEED, WHITELIST, OPS, CUSTOM_SERVER_PROPERTIES...; Bedrock: LEVEL_NAME, GAMEMODE, LEVEL_SEED, ALLOW_LIST_USERS, TICK_DISTANCE...) **only on the first start** (while `server.properties` does not exist), so later Properties edits are kept. Carried by clone/template/serverpack export.
- POST /servers/:id/power {action: start|stop|restart|kill}
- POST /servers/:id/command {command} (RCON)
- GET /servers/:id/logs?tail=500
- GET /servers/:id/stats -> Stats payload ; GET /servers/:id/players
- Players: POST /servers/:id/players/:name/{op|deop|kick|ban|pardon|whitelist-add|whitelist-remove} ; GET /servers/:id/lists/{whitelist|ops|banned}
- Properties: GET/PUT /servers/:id/properties (server.properties as key/value object)
- Files: GET /servers/:id/files?path= (list) ; GET /servers/:id/files/content?path= ; PUT /servers/:id/files/content {path,content} ; POST /servers/:id/files/upload (multipart, ?path=) ; GET /servers/:id/files/download?path= ; POST /servers/:id/files/mkdir ; POST /servers/:id/files/rename ; DELETE /servers/:id/files?path=  (path-traversal safe, confined to server dir)
- Backups: GET/POST /servers/:id/backups ; POST /servers/:id/backups/:bid/restore ; GET .../download ; DELETE
- Schedules: GET/POST /servers/:id/schedules ; PATCH/DELETE /schedules/:sid
- Webhooks: GET/POST /servers/:id/webhooks ; PATCH/DELETE /webhooks/:wid ; POST /webhooks/:wid/test
- Shares: GET/POST /servers/:id/shares {userId,level} ; DELETE /servers/:id/shares/:userId
- Mods: GET /servers/:id/mods (installed jars) ; POST /servers/:id/mods/install {source,projectId,fileId?} ; DELETE /servers/:id/mods/:file ; GET /servers/:id/mods/updates
- Clone: POST /servers/:id/clone {name} ; Save template: POST /servers/:id/template {name,description,shared}
- Export: GET /servers/:id/export?format=curseforge|modrinth|serverpack (zip download) ; Import: POST /servers/import (multipart: CurseForge zip or .mrpack or server pack) -> creates server
- Templates: GET /templates ; POST /templates/:id/instantiate {name,...overrides} ; DELETE /templates/:id

Catalog (proxy; auth required)
- GET /catalog/search?source=curseforge|modrinth&q=&kind=modpack|mod|plugin&mcVersion=&loader=&offset=
- GET /catalog/project/:source/:id ; GET /catalog/project/:source/:id/versions?mcVersion=&loader=
- GET /catalog/minecraft/versions?type=<ServerType> (vanilla/paper/fabric… version list; cached)

## Stats payload
`{ status: "running"|"stopped"|"starting"|"stopping"|"crashed"|"installing", uptimeSec, memory:{usedMb,limitMb}, cpuPercent, tps:number|null, mspt:{avg:number|null,p95:number|null}, players:{online,max,list:[{name}]}, motd, version, source:"agent"|"rcon"|"docker", diskMb }`
Tick avg from `tick query` output (MC >=1.20.3) when RCON ok; otherwise null.

## WebSocket `/ws` (cookie auth). Client sends JSON:
`{type:"subscribe", serverId, channels:["logs","stats"]}` / `{type:"unsubscribe", serverId}` / `{type:"command", serverId, command}`
Server pushes: `{type:"log", serverId, line}` (backlog of last 200 lines on subscribe), `{type:"stats", serverId, stats}` (every 2 s), `{type:"status", serverId, status}`, `{type:"error", message}`. Permissions same as REST (viewer can read logs/stats; operator+ command).

## Frontend pages
Login (+MFA step) · Dashboard (server cards w/ status) · Create server wizard (type, version, modpack search CurseForge/Modrinth, resources, port) · Server page tabs: Overview (live stats like the Minecraft vanilla server GUI: memory bar, avg tick time graph, players list, live log + command input), Console, Players, Files, Properties, Mods, Backups, Schedules, Webhooks, Sharing, Export/Import, Settings · Templates · Account (password, TOTP, passkeys, API tokens, language/theme, quota) · Admin: Users, Settings (port pool, CurseForge key), Ports, Audit, System. PWA: manifest, service worker (vite-plugin-pwa), icons, installable.

---
# Self-update feature (v0.2) – binding contract

Decisions (owner): GitHub Releases + semver tags (`vX.Y.Z`); stable releases only (GitHub `releases/latest` already excludes drafts/prereleases; also ignore any with `prerelease:true`); Docker install = **notify only** (show `docker compose pull && docker compose up -d`); LXC/source-checkout install = **Update button** in the UI; keep previous version for **rollback**; **warn if game servers are running** (they're separate containers and keep running; only the panel restarts for ~30s); **verify** the release: the tag's commit SHA from the GitHub API must equal `git rev-parse <tag>^{commit}` after fetching from the configured origin (which must be https://github.com/<UPDATE_REPO>.git), and surface GitHub's `verification.verified` for the tag/commit as `verified`.

Env: `UPDATE_REPO` (default `joaquincabrerasimoes/ServCrafty`), `UPDATE_CHECK` (default on; `0` disables network checks), `INSTALL_TYPE` (`docker` is set in the Dockerfile; `lxc` optional; if unset: app root has `.git` -> `lxc`, else `source`). Current version = `server/package.json` version (read at runtime); current commit from `git rev-parse HEAD` when available. GitHub calls unauthenticated with ETag + 6h cache (+ optional `GITHUB_TOKEN` env), 60 req/h limit respected; `checkError` reports failures; never crash on network errors.

## Apply mechanism (LXC/source)
The app must NOT update itself in-process (systemd kills the cgroup on restart). `POST apply` validates, then spawns the updater **outside the service cgroup**: `systemd-run --unit=servcrafty-updater --collect --no-block bash <copy-of lxc/apply-update.sh> <tag> <expectedSha> <appRoot> <dataDir>`; the script is first copied to `$DATA_DIR/update/apply-update.sh` (git checkout replaces the repo's copy mid-run). `apply-update.sh` (bash, set -Eeuo pipefail): lock file; write `$DATA_DIR/update/status.json` {state,step,targetVersion,fromVersion,startedAt,finishedAt,message} and append to `$DATA_DIR/update/update.log` at each step; steps: verify (origin url check, `git fetch --tags --force origin`, tag exists, `git rev-parse tag^{commit}` == expected sha, refuse if working tree dirty in tracked files); backup (record previous SHA/version into `$DATA_DIR/update/previous.json`, copy `server/dist` and `web/dist` to `$DATA_DIR/update/prev/`); checkout (`git checkout --detach <tag>`); install (`npm install --workspaces --include-workspace-root`); build (`npm run build --workspace web && npm run build --workspace server`); restart (`systemctl restart servcrafty`); health (poll `http://127.0.0.1:$PORT/api/health` up to 120s until ok AND reported `version` == target); on ANY failure after backup start: automatic rollback (checkout previous SHA, restore dist from prev/, `npm install`, restart, wait healthy) and state `rolled_back` with message. Success -> state `succeeded`. Manual rollback uses the same code path (`apply-update.sh --rollback`). Note DB migrations are forward-only and additive; mention in UI/docs that a rollback does not revert DB migrations.
`GET /api/health` additionally returns `version`.

## REST (admin only; audit-logged `update.check|update.apply|update.rollback`)
- `GET /api/admin/update` -> `{ currentVersion, commit: string|null, installType: "lxc"|"docker"|"source", canUpdate: boolean, cannotUpdateReason: string|null, checkedAt: ISO|null, checkError: string|null, updateAvailable: boolean, latest: null | { version, tag, name, notes (markdown), url, publishedAt, commitSha, verified: boolean }, dockerCommand: string|null, runningServers: number, status: { state: "idle"|"running"|"succeeded"|"failed"|"rolled_back", step: string|null, fromVersion: string|null, targetVersion: string|null, startedAt: ISO|null, finishedAt: ISO|null, message: string|null }, rollbackAvailable: boolean, previousVersion: string|null }` (cached; reads status.json).
- `POST /api/admin/update/check` -> same payload after a forced fresh check (rate limited).
- `POST /api/admin/update/apply` body `{ version?: string }` -> `202` same payload. Errors: `409 update_in_progress`, `400 cannot_update` (installType != lxc/source-with-systemd, missing git/systemd-run), `400 no_update`.
- `POST /api/admin/update/rollback` -> `202`; `400 no_rollback`.
- `GET /api/admin/update/log?offset=N` -> `{ text, offset, state }` (tail of update.log from byte offset).
`canUpdate` requires: installType lxc|source, `git` repo present, `systemd-run` + `systemctl` available, running as root, app root writable.

## CI (GitHub Actions) `.github/workflows/release.yml`
On push of tag `v*.*.*`: verify tag == `server/package.json` version (fail otherwise); build & push `ghcr.io/<owner>/servcrafty:<version>` and `:latest` (docker/build-push-action, linux/amd64, `permissions: packages: write, contents: write`); create the GitHub Release with auto-generated notes (`gh release create --generate-notes --verify-tag`, mark as prerelease if the tag has a `-` suffix like `v1.0.0-rc.1`). Also a `scripts/release.sh <patch|minor|major|X.Y.Z>` that bumps versions in root/server/web package.json, commits "Release vX.Y.Z", tags, and prints the push command (does not push).

## Frontend
Admin-only: (1) a dismissible banner in the main layout when `updateAvailable` ("ServCrafty vX is available – you're on vY"; link to the Updates page; dismissal remembered per version in localStorage; check on mount and every 30 min); (2) page `/admin/update` ("Updates", in the admin nav) with current/latest versions, install type, release notes (render markdown safely: headings, lists, links, code; no raw HTML), `verified` badge, "Check now", and: for `lxc/source` an **Update to vX** button with a confirm dialog that shows the warning "the panel restarts for about 30 s; N game server(s) are running and will keep running" (when runningServers>0), then a live progress view (poll `GET /admin/update` + `/log` every 2 s, tolerate the API being down during restart, reload the page when the new version reports healthy), result states succeeded/failed/rolled_back with message, and a **Rollback to previous version** button when `rollbackAvailable`; for `docker` show the command from `dockerCommand` with a copy button and no update button; when `!canUpdate` show `cannotUpdateReason`. Current version shown in the sidebar/footer and on the System page. i18n en + es. 

## Host-wide limits (v0.1.3)
- Admin setting `globalLimits` `{maxServers,maxRamMb,maxCpu,maxDiskMb}` (null = no cap), in `GET/PUT /api/admin/settings` (also returns `hostUsage`). Caps apply to ALL users' servers combined and also bind admins; checked on create and on edits that grow a resource (400 `host_capacity_exceeded`). With a disk cap set, a server needs a disk limit.
- `GET /api/account/quota` adds `host: {limits, usage}`; the UI shows each user's effective limit = min(own quota, what the host still has free), and `∞` only when neither exists.
- `GET /api/servers/:id/join-attempts`, `DELETE /api/servers/:id/join-attempts/:name`: players refused by the whitelist (Java, parsed from the log).
