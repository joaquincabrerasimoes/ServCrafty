# ServCrafty – Technical Spec (source of truth for backend + frontend)

Monorepo (npm workspaces): `server/` (Fastify + TypeScript, ESM), `web/` (React + Vite + TS + Tailwind, PWA), `docker/`, `lxc/`.
Production: the server serves `web/dist` statically and the API under `/api`; WebSockets under `/ws`.

## Decisions (from the owner – do not change)
- Stack: Node 22+/TypeScript, Fastify, React+Vite. DB: **PostgreSQL** (external; `DATABASE_URL`), via `pg` + plain SQL migrations (`server/migrations/*.sql`, applied at boot, tracked in `schema_migrations`). No ORM.
- Servers run as sibling containers inside a **bundled privileged dockerd** (DinD) in the ServCrafty container. Docker access via `dockerode` on `DOCKER_HOST` (default unix:///var/run/docker.sock). Images: `itzg/minecraft-server` (Java, all types, CurseForge/Modrinth modpacks) and `itzg/minecraft-bedrock-server` (Bedrock).
- Server types: VANILLA, PAPER, PURPUR, FOLIA, FABRIC, QUILT, FORGE, NEOFORGE, BEDROCK, plus modpack sources CURSEFORGE and MODRINTH (itzg `TYPE=AUTO_CURSEFORGE` / `MODRINTH`).
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
servers(id uuid, owner_id, name, type, mc_version, loader_version, modpack jsonb (source, project_id, file_id/version_id, name), java_args, memory_mb, cpu numeric, disk_mb, port int unique, env jsonb, container_id, status, auto_restart bool, created_at)
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
- GET /servers ; POST /servers {name,type,mcVersion,loaderVersion?,modpack?,memoryMb,cpu,diskMb?,port? (auto from pool if omitted),env?{},autoRestart?,eula:true} ; GET /servers/:id ; PATCH /servers/:id ; DELETE /servers/:id
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
