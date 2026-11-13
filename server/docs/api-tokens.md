# ServCrafty API guide

This guide explains how to drive your ServCrafty panel from scripts, CI jobs, chat bots or any other program using an **API token**. A machine-readable description of every endpoint is available as an OpenAPI 3 file (`servcrafty-openapi.json`, same download menu).

- Panel: `{{BASE_URL}}`
- API base URL: `{{BASE_URL}}/api`
- Examples below use the placeholder `scf_xxxxxxxx`. It is not a real token: use your own.

---

## 1. What an API token is

An API token is a long random secret that identifies **you** to the API without a password and without a browser.

- **A token has exactly the permissions of the account that created it.** If you own a server, the token can do everything you can do to it. If someone shared a server with you as *viewer*, the token can only read it. If you are an administrator, the token is an administrator token.
- Tokens start with `scf_`. Only a hash is stored on the server: the plaintext is shown **once**, when you create it, and cannot be recovered. Lost tokens must be revoked and replaced.
- Tokens skip the login and the second factor (TOTP / passkey). That is what makes them convenient for automation, and why they must be protected like a password (see [Security advice](#10-security-advice)).
- A token can optionally expire. You can have at most **50 tokens** per account.
- Disabling a user deletes all of that user's tokens.

### What a token cannot do

Some actions need an interactive browser login on purpose, so a leaked token cannot take over the account. With a Bearer token these answer `403` with code `session_required`:

| Action | Endpoint |
| --- | --- |
| Create a new API token | `POST /account/tokens` |
| Change your password | `POST /account/password` |
| Set up / enable / disable TOTP | `POST /account/totp/*` |
| Register / remove passkeys | `POST /account/passkeys/*`, `DELETE /account/passkeys/:id` |

Everything else is available, including listing and **revoking** tokens (`GET /account/tokens`, `DELETE /account/tokens/:id`).

Admin tokens can additionally manage users (including resetting another user's password or second factor), settings and the game catalogue. Create admin tokens only when you really need them.

---

## 2. Creating and revoking a token

1. Sign in to the panel in your browser.
2. Open **Account** > **API tokens**.
3. Enter a name that says where the token will be used (for example `github-actions` or `discord-bot`), optionally an expiry (days or a date), and press **Create**.
4. Copy the token that is displayed. **It is shown only once.**

To revoke a token, press **Delete** next to it in the same list (or call `DELETE {{BASE_URL}}/api/account/tokens/<id>`). Revocation is immediate. The list shows the token prefix (`scf_` plus six characters), when it was created, when it was last used (updated at most once a minute) and when it expires.

An expired or revoked token is simply not recognised: requests answer `401`.

---

## 3. Authenticating

Send the token in the `Authorization` header of every request:

```
Authorization: Bearer scf_xxxxxxxx
```

Quick check that the token works (`authVia` is `token`):

```bash
export BASE="{{BASE_URL}}/api"
export TOKEN="scf_xxxxxxxx"

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/auth/me"
```

```json
{ "user": { "id": "7c0f...", "username": "alice", "role": "user" }, "mfa": { "totp": false, "passkeys": 0 }, "authVia": "token" }
```

Notes:

- Use HTTPS in production. A token sent over plain HTTP can be read by anyone on the path.
- If a request carries a `Bearer` header the token is the *only* identity considered: a wrong token is a `401` even if you also send a browser cookie.
- Request and response bodies are JSON (`Content-Type: application/json`), UTF-8, except file uploads (`multipart/form-data`) and downloads.
- Identifiers (servers, backups, schedules, ...) are UUIDs; timestamps are ISO 8601 UTC strings.
- `GET /health` needs no token and reports the panel, database and Docker state.

### The LAN-only rule for administrators

When an administrator has configured the **LAN networks** setting (Admin > Settings), these accounts may only be used from the local network:

- the bootstrap admin (the account created from `ADMIN_USERNAME`), and
- every other administrator **without** a second factor (no TOTP and no passkey).

A request with such an account's token that comes from outside the configured ranges (including anything that arrives through Cloudflare or another tunnel, which the panel recognises by its headers) is treated as if the token did not exist: you get `401 unauthorized`, and the panel records an `auth.blocked_remote` audit entry. Fixes: call the API from inside the LAN, enable TOTP or a passkey on the admin account, or use a non-admin account for remote automation. Normal (non-admin) users are not affected.

---

## 4. Responses, errors and status codes

Successful responses are JSON objects or arrays (a few endpoints return files). Most write operations return the changed object, or `{ "ok": true }`.

Every error has the same shape:

```json
{ "error": { "code": "server_not_found", "message": "Server not found" } }
```

`code` is stable and meant for programs; `message` is English text for people. Validation errors (`validation_error`) put the first problem in `message` (for example `memoryMb: Number must be greater than or equal to 512`) and the complete list of issues in `error.details`.

| Status | Meaning | Typical codes |
| --- | --- | --- |
| `200` | OK | |
| `201` | Created (servers, backups, schedules, webhooks, templates) | |
| `202` | Accepted (admin self-update, rollback) | |
| `400` | Invalid input or an option the game does not support | `validation_error`, `invalid_json`, `unsupported_game`, `invalid_minecraft_config`, `invalid_terraria_config`, `invalid_steam_config`, `quota_exceeded`, `multipart_required`, `invalid_cron`, `unsupported` |
| `401` | No / invalid / expired token, or LAN-only block | `unauthorized`, `mfa_required` (cookie sessions only) |
| `403` | Authenticated but not allowed | `insufficient_access`, `admin_required`, `session_required`, `game_not_allowed` |
| `404` | Does not exist, **or you have no access to it** | `server_not_found`, `backup_not_found`, `not_found` |
| `409` | Conflict with the current state | `not_running`, `game_disabled`, `no_free_ports`, `token_limit`, `backup_in_progress`, `user_has_servers`, `last_admin` |
| `413` | Upload larger than the limit | `file_too_large` |
| `429` | Rate limited | `rate_limited` |
| `5xx` | Server or upstream problem | `internal_error`, `upstream_error`, `webhook_failed` |

Two things worth knowing:

- A server you have no access to answers **404**, not 403, so existence is not leaked. A server you can see but may not change answers 403 `insufficient_access` (the message names the level needed: `viewer`, `operator`, `manager`, or `full` for owner/admin only).
- Access levels, lowest to highest: **viewer** (read, logs, stats), **operator** (power, console, players, backups), **manager** (settings, files, schedules, sharing, mods, restore) and **owner / admin** (everything, including deleting the server).

---

## 5. Pagination, limits and rate limits

There is **no general pagination**: list endpoints (`/servers`, `/backups`, `/schedules`, ...) return everything you can see. The few paged endpoints:

| Endpoint | Parameters |
| --- | --- |
| `GET /admin/audit` | `limit` (1-500, default 50), `offset`, `user`, `action` (prefix). Returns `{ items, total }`. |
| `GET /catalog/search` | `offset` (0-9950), `limit` (1-50, default 20). |
| `GET /workshop/search` | `page` (1-500), `sort`. |
| `GET /servers/{id}/logs` | `tail` = number of lines (1-5000, default 500). |

Rate limits, as they really are:

- **There is no global request limit.** Be a good citizen anyway (poll status every few seconds, not in a tight loop; prefer the WebSocket for live data).
- Login attempts: 10 per 5 minutes per address and username. Second-factor attempts: 10 per 5 minutes per login. Update checks (`POST /admin/update/check`): 6 per 10 minutes per user.
- When a limit is hit you receive `429` with code `rate_limited`; the `message` says how many seconds to wait. No `Retry-After` header is sent.

Size limits: JSON bodies up to 12 MiB; text files edited through `/files/content` up to 5 MiB; uploaded files up to 8 GiB each (50 per request); Terraria world imports up to 256 MiB. Quotas (servers, RAM, CPU, disk) set by the administrator apply to API calls exactly like the UI: breaking one gives `400 quota_exceeded`.

---

## 6. Concepts you need for the recipes

- **Server types.** `type` is one of `VANILLA PAPER PURPUR FOLIA SPIGOT BUKKIT FABRIC QUILT FORGE NEOFORGE CURSEFORGE MODRINTH` (Minecraft Java), `BEDROCK` (Minecraft Bedrock), `TERRARIA TSHOCK TMODLOADER` (Terraria) or `STEAMCMD` (any game from the SteamCMD catalogue; you choose the game with `steam.gameId`).
- **Creating a server does not start it.** The server is created stopped; call `POST /servers/{id}/power` with `{"action":"start"}`. The first start downloads images/game files and can take minutes; `status` goes `installing` / `starting` and then `running`.
- **Status values:** `running`, `stopped`, `starting`, `stopping`, `crashed`, `installing`.
- **Ports** are taken from the administrator's port pool. Leave `port` out and the panel picks a free one (SteamCMD servers always get theirs from the pool). The assigned port is in the response (`port`, plus `extraPorts` for games with several).
- **EULA.** Minecraft and Terraria servers must be created with `"eula": true`. SteamCMD servers do not take it.
- **Games you may create.** From v0.3.2 administrators grant each user a list of games and may disable a game entirely. Creating a server for a game you were not granted fails with `403 game_not_allowed`; for a disabled game with `409 game_disabled`. Existing servers keep working.
- **Game fields are game-specific.** Sending a field that belongs to another game (for example `steam` on a Minecraft server) is `400 unsupported_game`.

---

## 7. Recipes (curl)

All examples assume:

```bash
export BASE="{{BASE_URL}}/api"
export TOKEN="scf_xxxxxxxx"
AUTH="Authorization: Bearer $TOKEN"
```

[`jq`](https://jqlang.github.io/jq/) is used to pick values out of JSON; it is optional.

### 7.1 List servers and find one

```bash
curl -s -H "$AUTH" "$BASE/servers" | jq '.[] | {id, name, type, status, port, access}'

# Take the id of a server by name
SID=$(curl -s -H "$AUTH" "$BASE/servers" | jq -r '.[] | select(.name=="Survival") | .id')
curl -s -H "$AUTH" "$BASE/servers/$SID" | jq
```

### 7.2 Create a Minecraft Java server

```bash
curl -s -X POST "$BASE/servers" -H "$AUTH" -H "Content-Type: application/json" -d '{
  "name": "Survival",
  "type": "PAPER",
  "mcVersion": "LATEST",
  "memoryMb": 2048,
  "cpu": 2,
  "eula": true,
  "minecraft": {
    "gameMode": "survival",
    "difficulty": "normal",
    "motd": "Welcome!",
    "maxPlayers": 20,
    "whitelist": { "enabled": true, "users": ["Notch"] }
  }
}'
```

The `minecraft` block is optional and applied on the first start only (later edits go through `PUT /servers/{id}/properties`). Version lists are available from `GET /catalog/minecraft/versions?type=PAPER`. Modpacks use `"type":"MODRINTH"` or `"CURSEFORGE"` with `"modpack":{"source":"modrinth","projectId":"..."}` (CurseForge needs an API key configured by an admin). Bedrock is the same with `"type":"BEDROCK"`.

### 7.3 Create a Terraria server

```bash
curl -s -X POST "$BASE/servers" -H "$AUTH" -H "Content-Type: application/json" -d '{
  "name": "Terra",
  "type": "TSHOCK",
  "memoryMb": 2048,
  "cpu": 2,
  "eula": true,
  "terraria": { "worldName": "MyWorld", "size": 2, "difficulty": 0, "maxPlayers": 8, "motd": "Hello" }
}'
```

`type` may be `TERRARIA` (vanilla), `TSHOCK` or `TMODLOADER`. `size`: 1 small, 2 medium, 3 large. `difficulty`: 0 normal, 1 expert, 2 master, 3 journey. To use an existing world, upload it with `POST /servers/{id}/terraria/world` (multipart, field `file` with the `.wld`).

### 7.4 Create a SteamCMD game server (for example Satisfactory)

First look at what the panel offers. Each entry has `id`, `variables` (the settings you can pass in `steam.vars`), the ports and the recommended `resources`:

```bash
curl -s -H "$AUTH" "$BASE/games" | jq '.[] | {id, name, hasWorkshop, disabled}'
curl -s -H "$AUTH" "$BASE/games" | jq '.[] | select(.id=="satisfactory") | {variables, resources, ports}'
```

Then create the server. No `port` and no `eula` here: ports are allocated from the pool, and generated secrets (admin / RCON passwords) are created for you.

```bash
curl -s -X POST "$BASE/servers" -H "$AUTH" -H "Content-Type: application/json" -d '{
  "name": "Satisfactory",
  "type": "STEAMCMD",
  "memoryMb": 8192,
  "cpu": 4,
  "steam": {
    "gameId": "satisfactory",
    "vars": { "maxPlayers": 4 },
    "updateOnStart": true
  }
}'
```

Unknown variables, wrong types or values outside the allowed range are rejected with `400 invalid_steam_config` (the message names the variable). Read `steam.vars` of the created server (managers and owners see secrets) to get generated passwords, and use `POST /servers/{id}/steam/regenerate` `{"key":"..."}` to make a new one.

Other SteamCMD actions: `POST /servers/{id}/steam/update` (validate game files on next start, restarting now if it is running).

### 7.5 Start, stop, restart, kill

```bash
curl -s -X POST "$BASE/servers/$SID/power" -H "$AUTH" -H "Content-Type: application/json" -d '{"action":"start"}'
# actions: start | stop | restart | kill
```

`start` and `restart` answer after a fraction of a second while the server comes up in the background. Poll until it is running:

```bash
until [ "$(curl -s -H "$AUTH" "$BASE/servers/$SID/stats" | jq -r .status)" = "running" ]; do sleep 5; done
echo ready
```

`stop` waits for the graceful shutdown and returns the final status. `kill` stops the container immediately (unsaved data may be lost). Operator access is needed. If an administrator disabled the game with *block start*, start/restart answer `409 game_disabled`.

### 7.6 Send a console command

```bash
curl -s -X POST "$BASE/servers/$SID/command" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"command":"say Server restarts in 5 minutes"}'
# {"output":""}
```

The server must be running (`409 not_running` otherwise). Minecraft Java answers through RCON, so `output` contains the command's result (for example from `list`). Terraria and Steam consoles are written to the process input; `output` may be empty and the effect shows up in the logs.

### 7.7 Logs, statistics and players

```bash
curl -s -H "$AUTH" "$BASE/servers/$SID/logs?tail=100" | jq -r '.lines[]'
curl -s -H "$AUTH" "$BASE/servers/$SID/stats" | jq '{status, uptimeSec, cpuPercent, memory, tps, players}'
curl -s -H "$AUTH" "$BASE/servers/$SID/players" | jq

# Player actions (operator): op deop kick ban pardon whitelist-add whitelist-remove
curl -s -X POST "$BASE/servers/$SID/players/Notch/kick" -H "$AUTH" -H "Content-Type: application/json" -d '{"reason":"AFK"}'
curl -s -H "$AUTH" "$BASE/servers/$SID/lists/banned"     # whitelist | ops | banned
```

`logs` gives the last lines only. To follow logs live use the [WebSocket](#8-websocket-live-logs-and-stats). SteamCMD games report players over A2S when the game supports it.

### 7.8 Files (manager access)

Paths are relative to the server's data directory; `..` and absolute paths are refused.

```bash
# list a directory (empty path = root)
curl -s -H "$AUTH" "$BASE/servers/$SID/files?path=plugins" | jq '.entries[] | {name, type, size}'

# read a text file (up to 5 MiB)
curl -s -H "$AUTH" -G "$BASE/servers/$SID/files/content" --data-urlencode "path=server.properties" | jq -r .content

# write a text file
curl -s -X PUT "$BASE/servers/$SID/files/content" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"path":"ops.json","content":"[]"}'

# upload one or more files into a directory (multipart/form-data, field name "file")
curl -s -X POST "$BASE/servers/$SID/files/upload?path=plugins" -H "$AUTH" -F "file=@./MyPlugin.jar"

# download a file
curl -s -H "$AUTH" -G "$BASE/servers/$SID/files/download" --data-urlencode "path=logs/latest.log" -o latest.log

# create a folder, rename/move, delete
curl -s -X POST "$BASE/servers/$SID/files/mkdir"  -H "$AUTH" -H "Content-Type: application/json" -d '{"path":"backups-local"}'
curl -s -X POST "$BASE/servers/$SID/files/rename" -H "$AUTH" -H "Content-Type: application/json" -d '{"from":"a.txt","to":"b.txt"}'
curl -s -X DELETE -H "$AUTH" -G "$BASE/servers/$SID/files" --data-urlencode "path=old.txt"
```

Do not set `Content-Type` yourself for uploads: curl adds the multipart boundary for `-F`. Changed files take effect after a restart (for settings files, the game decides).

### 7.9 Backups

```bash
# create (operator): returns when the archive is complete
curl -s -X POST "$BASE/servers/$SID/backups" -H "$AUTH" -H "Content-Type: application/json" -d '{"note":"before update"}'
# SteamCMD servers: add ?includeGame=1 to also archive the re-downloadable game files

# list
curl -s -H "$AUTH" "$BASE/servers/$SID/backups" | jq '.[] | {id, file, sizeBytes, kind, createdAt, note}'

# download the .tar.gz (operator)
BID=$(curl -s -H "$AUTH" "$BASE/servers/$SID/backups" | jq -r '.[0].id')
curl -s -H "$AUTH" "$BASE/servers/$SID/backups/$BID/download" -o backup.tar.gz

# restore (manager): a running server is stopped, restored and started again
curl -s -X POST -H "$AUTH" "$BASE/servers/$SID/backups/$BID/restore"

# delete (manager)
curl -s -X DELETE -H "$AUTH" "$BASE/servers/$SID/backups/$BID"
```

### 7.10 Schedules (manager)

```bash
# restart every day at 04:00, warning the players 60 seconds before
curl -s -X POST "$BASE/servers/$SID/schedules" -H "$AUTH" -H "Content-Type: application/json" -d '{
  "cron": "0 4 * * *",
  "action": "restart",
  "payload": { "warnSeconds": 60 }
}'

# backup every 6 hours, keep the last 10 scheduled backups
curl -s -X POST "$BASE/servers/$SID/schedules" -H "$AUTH" -H "Content-Type: application/json" -d '{
  "cron": "0 */6 * * *", "action": "backup", "payload": { "keep": 10, "note": "auto" }
}'

# run a console command on a schedule
curl -s -X POST "$BASE/servers/$SID/schedules" -H "$AUTH" -H "Content-Type: application/json" -d '{
  "cron": "*/30 * * * *", "action": "command", "payload": { "command": "say Remember to vote!" }
}'

curl -s -H "$AUTH" "$BASE/servers/$SID/schedules" | jq        # list
curl -s -X PATCH "$BASE/schedules/<scheduleId>" -H "$AUTH" -H "Content-Type: application/json" -d '{"enabled":false}'
curl -s -X POST  -H "$AUTH" "$BASE/schedules/<scheduleId>/run"  # run now
curl -s -X DELETE -H "$AUTH" "$BASE/schedules/<scheduleId>"
```

`action` is `restart`, `command`, `backup`, `start` or `stop`. Cron expressions are evaluated in the time zone of the machine running the panel (usually UTC) and use the standard 5 fields (a 6th, seconds, is accepted).

### 7.11 Steam Workshop (SteamCMD games that support it)

`GET /games` marks them with `hasWorkshop` (for example Project Zomboid, Killing Floor 1/2, Unturned). Searching the catalogue needs a Steam Web API key set by an administrator (`400 steam_key_missing` otherwise); adding an item by id or URL does not.

```bash
# search the Workshop of a game
curl -s -H "$AUTH" -G "$BASE/workshop/search" --data-urlencode "gameId=project-zomboid" --data-urlencode "q=map" | jq

# add items to a server by id or URL (manager)
curl -s -X POST "$BASE/servers/$SID/workshop" -H "$AUTH" -H "Content-Type: application/json" -d '{"id":"1234567890"}'
curl -s -X POST "$BASE/servers/$SID/workshop" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"url":"https://steamcommunity.com/sharedfiles/filedetails/?id=1234567890"}'

curl -s -H "$AUTH" "$BASE/servers/$SID/workshop" | jq                      # list
curl -s -X DELETE -H "$AUTH" "$BASE/servers/$SID/workshop/1234567890"      # remove
curl -s -X POST   -H "$AUTH" "$BASE/servers/$SID/workshop/refresh"         # re-download on next start
```

Workshop changes apply on the next start (`restartRequired` tells you whether the server is running). An item from another game is rejected with `400 workshop_wrong_game`. At most 200 items per server.

### 7.12 BlueMap live map (Java servers)

BlueMap draws a 3D map of a Java server (Paper, Purpur, Folia, Spigot, Fabric, Quilt, Forge, NeoForge; not Vanilla or modpack servers). The rendered map is stored in the panel's PostgreSQL database, in a schema of its own per server, and is viewed in the panel (the viewer is a browser page, not part of the token API). `bluemap.enabled` and `bluemap.url` are part of the server JSON.

```bash
curl -s -H "$AUTH" "$BASE/servers/$SID/bluemap" | jq        # supported? enabled? stored size, dbIssue

# enable (manager). You must accept Mojang's EULA: BlueMap downloads the Minecraft client from Mojang.
curl -s -X PUT "$BASE/servers/$SID/bluemap" -H "$AUTH" -H "Content-Type: application/json" -d '{"enabled":true,"acceptDownload":true}'

# disable but keep the rendered map / disable and delete it (server must be stopped for deleteData)
curl -s -X PUT "$BASE/servers/$SID/bluemap" -H "$AUTH" -H "Content-Type: application/json" -d '{"enabled":false}'
curl -s -X PUT "$BASE/servers/$SID/bluemap" -H "$AUTH" -H "Content-Type: application/json" -d '{"enabled":false,"deleteData":true}'

# owner only: public links (anyone with the URL views the live map without signing in).
# canEdit=true lets the visitors also add markers (and change the ones that link created).
curl -s -X POST "$BASE/servers/$SID/bluemap/links" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"Friends","canEdit":true}' | jq .url
curl -s -H "$AUTH" "$BASE/servers/$SID/bluemap/links" | jq '.links[] | {id,name,canEdit,url}'
# rename / change the edit right / new URL (the old one stops working)
curl -s -X PATCH "$BASE/servers/$SID/bluemap/links/$LINK_ID" -H "$AUTH" -H "Content-Type: application/json" -d '{"canEdit":false,"regenerate":true}'
curl -s -X DELETE -H "$AUTH" "$BASE/servers/$SID/bluemap/links/$LINK_ID"

# markers (stored by ServCrafty, shown on the web map within ~15 s). types: poi, html, line, shape, extrude
curl -s -X POST "$BASE/servers/$SID/bluemap/markers" -H "$AUTH" -H "Content-Type: application/json"   -d '{"mapId":"world","type":"poi","label":"Home","detail":"Our base","position":{"x":120,"y":70,"z":-45}}'
curl -s -X POST "$BASE/servers/$SID/bluemap/markers" -H "$AUTH" -H "Content-Type: application/json"   -d '{"mapId":"world","type":"shape","label":"Farm","y":64,"color":"#44cc66","points":[{"x":0,"z":0},{"x":30,"z":0},{"x":30,"z":20},{"x":0,"z":20}]}'
curl -s -H "$AUTH" "$BASE/servers/$SID/bluemap/markers?mapId=world" | jq '.markers[] | {id,type,label}'
curl -s -X PATCH "$BASE/servers/$SID/bluemap/markers/$MARKER_ID" -H "$AUTH" -H "Content-Type: application/json" -d '{"label":"New name"}'
curl -s -X DELETE -H "$AUTH" "$BASE/servers/$SID/bluemap/markers/$MARKER_ID"
# marker sets (groups, one toggle each in the map menu)
curl -s -X POST "$BASE/servers/$SID/bluemap/marker-sets" -H "$AUTH" -H "Content-Type: application/json" -d '{"mapId":"world","label":"Bases"}'

# discard the rendered map so it renders again (server must be stopped)
curl -s -X POST -H "$AUTH" "$BASE/servers/$SID/bluemap/reset"
```

BlueMap is installed (and removed) at the next start of the server; `restartRequired` says whether a running server has to restart. Deleting the server deletes its map data. `400 bluemap_db_unreachable` means the panel database is on `localhost`, which game containers cannot reach: an administrator sets **BlueMap database address** in Admin > Settings. `400 bluemap_db_privileges` means the panel's database user may not create roles and schemas.

### 7.13 Other things you will want

```bash
# change settings (manager): partial update; restartRequired tells you if a restart is needed
curl -s -X PATCH "$BASE/servers/$SID" -H "$AUTH" -H "Content-Type: application/json" -d '{"memoryMb":4096,"autoRestart":true}'

# change a SteamCMD setting: vars are merged, null returns to the default
curl -s -X PATCH "$BASE/servers/$SID" -H "$AUTH" -H "Content-Type: application/json" -d '{"steam":{"vars":{"maxPlayers":8}}}'

# server.properties (Minecraft)
curl -s -H "$AUTH" "$BASE/servers/$SID/properties" | jq
curl -s -X PUT "$BASE/servers/$SID/properties" -H "$AUTH" -H "Content-Type: application/json" -d '{"motd":"New MOTD","pvp":false}'

# clone, save as template, create from a template
curl -s -X POST "$BASE/servers/$SID/clone" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"Survival copy"}'
curl -s -X POST "$BASE/servers/$SID/template" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"My template"}'
curl -s -X POST "$BASE/templates/<templateId>/instantiate" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"From template","eula":true}'

# share with another user (manager); find the id with /users/lookup?q=
curl -s -H "$AUTH" "$BASE/users/lookup?q=bob"
curl -s -X POST "$BASE/servers/$SID/shares" -H "$AUTH" -H "Content-Type: application/json" -d '{"userId":"<userId>","level":"operator"}'

# webhook to Discord for a server (manager); events: see GET /webhooks/events
curl -s -X POST "$BASE/servers/$SID/webhooks" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"url":"https://discord.com/api/webhooks/...","kind":"discord","events":["server.crashed","server.running"]}'

# your quota
curl -s -H "$AUTH" "$BASE/account/quota" | jq

# delete a server (owner/admin). Irreversible.
curl -s -X DELETE -H "$AUTH" "$BASE/servers/$SID"
```

Minecraft mods and plugins: `GET/POST /servers/{id}/mods...`, search with `GET /catalog/search`. Export a server as a modpack: `GET /servers/{id}/export?format=serverpack`.

**Game web admin pages and the BlueMap map.** Some games have their own web interface (`steamGame.webui` in the server JSON), and BlueMap serves a map. The panel exposes them through a sandboxed proxy under `/api/servers/{id}/webui/...` that is meant for browsers (it uses short-lived session URLs). It is not part of the token API; open it from the panel.

---

## 8. WebSocket: live logs and stats

Instead of polling, connect to `wss://<your-panel>/ws` (note: **not** under `/api`; for a plain-HTTP panel use `ws://`). The connection is authenticated by the same request that opens it, so non-browser clients can send the Bearer header:

```
GET /ws
Authorization: Bearer scf_xxxxxxxx
Upgrade: websocket
```

Browsers cannot set headers on a WebSocket; they use the login cookie instead, so a browser page cannot use a token for `/ws`. Clients that send an `Origin` header must come from the panel's own origin; scripts without an `Origin` are fine. If authentication fails the server sends `{"type":"error","code":"unauthorized"}` and closes with code `4401`.

Messages you send (JSON text, at most 64 KiB):

```json
{ "type": "subscribe", "serverId": "<uuid>", "channels": ["logs", "stats"] }
{ "type": "unsubscribe", "serverId": "<uuid>" }
{ "type": "command", "serverId": "<uuid>", "command": "list" }
{ "type": "ping" }
```

Messages you receive:

```json
{ "type": "status", "serverId": "<uuid>", "status": "running" }
{ "type": "log", "serverId": "<uuid>", "line": "[12:00:01] [Server thread/INFO]: Done" }
{ "type": "stats", "serverId": "<uuid>", "stats": { "status": "running", "cpuPercent": 3.2, "memory": { "usedMb": 1200, "limitMb": 2048 } } }
{ "type": "command_result", "serverId": "<uuid>", "command": "list", "output": "..." }
{ "type": "error", "serverId": "<uuid>", "message": "Operator access required to send commands" }
{ "type": "pong" }
```

On `subscribe` you first get the current `status`, then the last 200 log lines, then a `stats` snapshot; afterwards logs arrive as they are written and `stats` every 2 seconds. Permissions are the same as REST (viewers read, operators send commands). The panel pings every 30 seconds; answer pongs automatically (every WebSocket library does).

Node.js example (needs the `ws` package):

```js
import WebSocket from 'ws';

const ws = new WebSocket('{{BASE_URL}}'.replace(/^http/, 'ws') + '/ws', {
  headers: { Authorization: 'Bearer scf_xxxxxxxx' },
});
ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', serverId: '<uuid>', channels: ['logs'] })));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'log') console.log(msg.line);
});
```

---

## 9. Code examples

### Python (requests)

```python
import time
import requests

BASE = "{{BASE_URL}}/api"
TOKEN = "scf_xxxxxxxx"          # load it from an environment variable in real code


class ApiError(Exception):
    pass


def call(method, path, **kwargs):
    r = requests.request(method, BASE + path, headers={"Authorization": f"Bearer {TOKEN}"}, timeout=60, **kwargs)
    if not r.ok:
        err = r.json().get("error", {}) if r.headers.get("content-type", "").startswith("application/json") else {}
        raise ApiError(f"{r.status_code} {err.get('code')}: {err.get('message') or r.text}")
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else r.content


server = call("POST", "/servers", json={
    "name": "Survival", "type": "PAPER", "memoryMb": 2048, "cpu": 2, "eula": True,
})
sid = server["id"]
call("POST", f"/servers/{sid}/power", json={"action": "start"})

while call("GET", f"/servers/{sid}/stats")["status"] != "running":
    time.sleep(5)

print(call("POST", f"/servers/{sid}/command", json={"command": "list"})["output"])
call("POST", f"/servers/{sid}/backups", json={"note": "first backup"})

with open("MyPlugin.jar", "rb") as f:   # multipart upload: do not set Content-Type yourself
    call("POST", f"/servers/{sid}/files/upload", params={"path": "plugins"}, files={"file": f})
```

### Node.js (fetch, Node 18+)

```js
const BASE = '{{BASE_URL}}/api';
const TOKEN = process.env.SERVCRAFTY_TOKEN; // scf_xxxxxxxx

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  if (!res.ok) {
    const err = isJson ? (await res.json()).error : {};
    throw new Error(`${res.status} ${err?.code}: ${err?.message ?? res.statusText}`);
  }
  return isJson ? res.json() : Buffer.from(await res.arrayBuffer());
}

const server = await call('POST', '/servers', {
  name: 'Satisfactory', type: 'STEAMCMD', memoryMb: 8192, cpu: 4,
  steam: { gameId: 'satisfactory', vars: { maxPlayers: 4 } },
});
await call('POST', `/servers/${server.id}/power`, { action: 'start' });

let stats;
do {
  await new Promise((r) => setTimeout(r, 5000));
  stats = await call('GET', `/servers/${server.id}/stats`);
  console.log(stats.status, stats.install ?? '');
} while (stats.status !== 'running');

// Upload a file (multipart) with the built-in FormData / Blob
import { readFile } from 'node:fs/promises';
const form = new FormData();
form.append('file', new Blob([await readFile('Game.ini')]), 'Game.ini');
await fetch(`${BASE}/servers/${server.id}/files/upload?path=`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}` }, // no Content-Type: fetch sets the boundary
  body: form,
});
```

---

## 10. Security advice

- **Treat a token like a password.** Anyone holding it acts as you, from anywhere, without a second factor.
- Keep it out of source code, shell history, screenshots, tickets and chat. Use environment variables or your CI's secret store. The panel never logs the `Authorization` header.
- One token per integration, with a descriptive name, so you can revoke one without breaking the others.
- Give tokens an **expiry** whenever the use is temporary, and rotate long-lived ones regularly (create the new one, update the integration, then delete the old one).
- **Least privilege:** a token is as powerful as its owner. For a bot that only needs to read or restart one server, create a separate *user*, share just that server with it at *viewer* or *operator* level, and issue the token from that user. Avoid administrator tokens; if you must, keep them on the LAN and protect the account with TOTP or a passkey.
- Always use HTTPS when the panel is reachable from the Internet.
- Revoke a token the moment you suspect a leak (Account > API tokens > Delete, or `DELETE /account/tokens/{id}`), then look at **Admin > Audit log**: state-changing actions (power, commands, file writes, creations, deletions, ...) are recorded under your user with the client address.
- Expired and revoked tokens stop working immediately; disabling or deleting the user does the same for all of their tokens.

---

## 11. Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `401 unauthorized` on every call | Missing `Authorization: Bearer ...` header, typo, token revoked or expired, token of a disabled user. Check with `GET /auth/me`. |
| `401` only from outside the house/office | LAN-only rule: admin account without 2FA (or the bootstrap admin) used from outside the LAN or through a tunnel. Use a non-admin account, enable TOTP/passkey on the admin, or call from the LAN. |
| `403 session_required` | The action (create token, change password, MFA, passkeys) needs a browser login. |
| `403 insufficient_access` | Your account's level on that server is too low; the message says which level is needed. Ask the owner to raise your share. |
| `403 admin_required` | Admin-only endpoint called with a normal user's token. |
| `403 game_not_allowed` | An administrator has not granted you that game (Admin > Users > Games). |
| `404 server_not_found` | Wrong id, the server was deleted, or you have no access to it. |
| `409 game_disabled` | The game was disabled by an administrator (creation, or start when *block start* is on). |
| `400 bluemap_db_unreachable` / `bluemap_db_privileges` / `bluemap_eula_required` | BlueMap setup: the database host is `localhost` (set the BlueMap database address in Admin > Settings), the panel's database user lacks `CREATEROLE`/`CREATE`, or `acceptDownload: true` was missing. |
| `409 server_running` | The action (delete or reset BlueMap data) needs the server stopped. |
| `409 not_running` | Console commands need a running server. Start it and wait for `running`. |
| `409 no_free_ports` / `400 quota_exceeded` | Port pool exhausted / your quota or the host limits are used up. Delete a server or ask an admin. |
| `400 validation_error` | Read `message` (first problem) and `error.details` (all issues). Common: `memoryMb` below 512 (or the game's minimum), missing `eula: true`. |
| `400 unsupported_game` | A field from another game (for example `javaArgs` on a Terraria server). |
| `400 invalid_steam_config` | Unknown variable, wrong type or out-of-range value in `steam.vars`; see `GET /games` for the game's `variables`. |
| `400 multipart_required` | Upload sent as JSON. Use `multipart/form-data` (`curl -F`, `FormData`). |
| `400 invalid_json` | The body is not valid JSON, or the `Content-Type` header is wrong. |
| `413 file_too_large` | Upload over the size limit (Terraria worlds: 256 MiB). |
| `429 rate_limited` | Only login, second-factor and update-check calls are limited; wait the number of seconds in `message`. |
| Download is empty or truncated | Use `-o file` with curl (not `jq`), and do not follow a redirect to the login page: check the status code. |
| WebSocket closes with `4401` | The upgrade request had no valid token. Browsers cannot send the header; use a Node/Python client. |
| WebSocket closes with `1008` | Wrong `Origin`: omit the header in scripts. |
| Requests hang on start/restart | They do not: `start`/`restart` return quickly, the first start just takes minutes while images or game files download. Poll `stats`. |

Still stuck? The OpenAPI file lists every endpoint with exact request bodies, and **Admin > Audit log** shows the state-changing actions your token performed. Server logs of the panel contain the full error for any `5xx`.
