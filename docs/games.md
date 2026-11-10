# Game definitions: authoring guide

ServCrafty can run any dedicated server that SteamCMD can install, not only Minecraft and Terraria. A **game definition** is a JSON document that tells the panel how to install, configure, start, stop and observe one game. This guide is for administrators (and users granted "Can create game definitions") who want to add or adjust a game.

`SPEC.md`, section "SteamCMD games (v0.3.0)", is authoritative. If this guide and the implementation ever differ, follow SPEC.md and the validator (`server/src/lib/gameDefinition.ts`).

Contents

1. [Concepts](#1-concepts)
2. [Schema reference](#2-schema-reference)
3. [Templates](#3-templates)
4. [Ports](#4-ports)
5. [Variables](#5-variables)
6. [Launch](#6-launch)
7. [Files: template and ini](#7-files-template-and-ini)
8. [Stop, console, ready, players, query](#8-stop-console-ready-players-query)
9. [Workshop](#9-workshop)
10. [Web UI proxy](#10-web-ui-proxy)
11. [Scripts and security](#11-scripts-and-security)
12. [Testing a definition](#12-testing-a-definition)
13. [Worked example: Valheim (example only)](#13-worked-example-valheim-example-only)
14. [The built-in definitions and their limitations](#14-the-built-in-definitions-and-their-limitations)

---

## 1. Concepts

```
definition (JSON)  +  server settings (variables, ports, resources)
        |                          |
        +------------ panel ------+
                       |
              plan.json  (all templates resolved, secrets included, mode 0600)
                       |
        servcrafty-steamcmd container ("dumb executor")
```

* A **definition** is static metadata: what to install, which ports and settings exist, how to launch. Built-in definitions live in `server/games/*.json` and are read-only. Custom ones are stored in the database (`game_definitions`) and edited under **Admin > Games**.
* A **server** of type `STEAMCMD` refers to one definition by `gameId` and stores its own variable values, workshop items and allocated host ports.
* On every start the panel resolves definition + server into a **plan** (`/servcrafty/plan.json`, mounted read-only into the container). The image contains no game knowledge: its executor (`servcrafty-steam-run`) just follows the plan:
  1. install or update the game with SteamCMD (anonymous login),
  2. download Workshop items,
  3. run `scripts.postInstall`,
  4. write the `files` operations,
  5. run `scripts.preStart`,
  6. start the game and forward stop signals.
* The executor starts as root, fixes ownership of `/data`, then runs SteamCMD and the game as **uid 1000** (some games, such as Satisfactory, refuse to run as root).
* Container layout: `/data/game` is the install directory (all file paths in a definition are relative to it), `/data/workshop` holds Workshop downloads, `/data/steam` is the SteamCMD home. Backups include `/data` except `game/`, `workshop/` and `steam/` unless "include game files" is requested.

A definition can be **duplicated** from a built-in one in the Games page, which is usually the easiest way to start.

## 2. Schema reference

The schema is strict: **unknown keys are rejected**. Validate with the editor in Admin > Games (`POST /games/validate`) or from the command line:

```
cd server
npx tsx scripts/validate-game.ts games/*.json
```

The file name must be `<id>.json` for that script.

### Top level

| Field | Type | Required | Notes |
|---|---|---|---|
| `schema` | `1` | yes | Schema version. |
| `id` | string | yes | `^[a-z0-9][a-z0-9-]{1,39}$`. A custom id may not equal a built-in id. |
| `name` | string | yes | Display name (1-80 chars, one line). |
| `description` | string | no | Up to 4000 chars. Shown on the game card and in the wizard. Be honest about limitations here. |
| `icon` | string or null | no | `https://` URL, or `null`. A Steam header image `https://cdn.cloudflare.steamstatic.com/steam/apps/<appid>/header.jpg` is a good choice. |
| `steam` | object | yes | Install source, see below. |
| `resources` | object | yes | Defaults offered by the wizard. |
| `ports` | array (1-16) | yes | Network ports. |
| `variables` | array (0-100) | no | User-editable settings. |
| `launch` | object | yes | How to start the game. |
| `files` | array (0-50) | no | Config files to write before launch. |
| `stop` | object | no | Default: `SIGINT`, 60 s. |
| `console` | object | no | Default: `{"stdin": false}`. |
| `ready` | object or null | no | Log regex that marks the server as running. |
| `players` | object or null | no | Join/leave regexes. |
| `query` | object or null | no | Steam A2S query. |
| `workshop` | object or null | no | Steam Workshop support. |
| `webui` | array (0-8) | no | Web interfaces proxied by the panel. |
| `scripts` | object | no | `postInstall` and `preStart` shell snippets. |

### `steam`

| Field | Type | Default | Notes |
|---|---|---|---|
| `appId` | integer | required | The **dedicated server** app id when one exists (Satisfactory server is 1690800, not the game's 526870). |
| `branch` | string or null | `null` | SteamCMD beta branch (`-beta`). `null` or `"public"` = default branch. |
| `betaPassword` | string or null | `null` | Password for a private branch. |
| `platform` | `"linux"` or `"windows"` | `"linux"` | `windows` makes SteamCMD fetch the Windows depot and runs the game under Wine + Xvfb. Prefer a native Linux server whenever the game has one. |
| `login` | `"anonymous"` | `"anonymous"` | Only anonymous login is supported. Games that need an account cannot be installed. |

### `resources`

| Field | Type | Notes |
|---|---|---|
| `memoryMb` | integer | Default memory limit offered. |
| `memoryMinMb` | integer | Minimum the wizard will accept; must be <= `memoryMb`. |
| `cpu` | number | Default CPU count. |
| `diskMb` | integer or null | Approximate install size, shown as a hint. |

## 3. Templates

Strings in `launch.command`, `launch.env`, `files[*].content`, `files[*].set[*].value`, `webui[*].path` and `webui[*].auth` may contain `{{name}}`.

| Name | Meaning |
|---|---|
| `{{key}}` | The value of variable `key`, after its `valueMap` is applied. |
| `{{ports.<id>}}` | The **container-side** port number of port `<id>` (for a `mirror` port this is the allocated host port). |
| `{{server.name}}` | The server's name in the panel. |
| `{{server.id}}` | The server's id. |
| `{{workshop.ids}}` | Comma separated Workshop item ids. |

Limits: there is no code, no conditionals, no filters. An unknown name is a validation error. File `path` values and `workshop.dir` may **not** contain templates. Values are inserted verbatim: a launch argument is an argv element (never parsed by a shell), but a value written into an ini file or a URL option string is not escaped, so use `pattern` to forbid characters that would break the target format (spaces, `?`, newlines).

Booleans render as `true` / `false`; use `valueMap` to turn them into whatever the game expects (`1`/`0`, `True`/`False`, or any other text). For optional pieces of a launch argument prefer composite arguments (section 6).

## 4. Ports

```json
{ "id": "game", "label": "Game", "protocol": "udp", "containerPort": 7777,
  "mirror": false, "publish": true, "main": true }
```

| Field | Notes |
|---|---|
| `id` | `^[a-z][a-z0-9_-]{0,31}$`, unique. Used as `{{ports.<id>}}`. |
| `label` | Shown in the UI (review step, ports list). |
| `protocol` | `udp`, `tcp` or `both` (bound for tcp and udp). |
| `containerPort` | Port the game listens on inside the container. |
| `publish` | `true` (default): a host port is allocated from the panel's pool and published. `false`: not published at all; reachable only by the panel (web UI proxy, A2S query) over the docker network. |
| `mirror` | `true`: the container port **equals** the host port allocated from the pool. Required when the game advertises its own port (Steam browser, in-game server list, a port the client is told to reconnect to). Then pass `{{ports.<id>}}` to the game with its port flag or ini key. `containerPort` is then only the nominal default. A mirror port must be published. |
| `offset` | Optional `{"from": "<portId>", "by": 1..100}`: the host port is the host port of port `from` plus `by`. `from` must be a published port without an offset itself (no chains); the offset port must be published and cannot be the main port (keep the base port first or mark it `main`); two ports may not share the same `from` and `by`. Can be combined with `mirror`. |
| `main` | `true` on exactly one port (default: the first). It is the port shown in the UI and used by "copy address"; it is stored in `servers.port` and must be published. |

Use `publish:false` for admin web interfaces: they are proxied (and authenticated) by the panel instead of being exposed. Two non-mirror ports may not declare the same container port/protocol.

**Derived ports (`offset`).** Some games require a second port at a fixed distance from the game port (Steam query = game port + 1). Declare it with `offset` and, if the game derives it itself, `mirror`:

```json
{ "id": "game",  "label": "Game",  "protocol": "udp", "containerPort": 7707, "mirror": true, "main": true },
{ "id": "steamquery", "label": "Steam query", "protocol": "udp", "containerPort": 7708, "mirror": true,
  "offset": { "from": "game", "by": 1 } }
```

The panel allocates the base port from the pool and the offset port as exactly base + 1, so both are free together; with `mirror` the container ports equal the host ports and `{{ports.steamquery}}` renders that number.

## 5. Variables

```json
{ "key": "maxPlayers", "label": "Max players", "description": "...",
  "type": "number", "default": 4, "required": false,
  "min": 1, "max": 127, "integer": true, "group": "Server" }
```

| Field | Notes |
|---|---|
| `key` | `^[A-Za-z][A-Za-z0-9_]{0,47}$`. `ports`, `server` and `workshop` are reserved. |
| `label`, `description` | What the user sees. Say what the setting does, units and valid values. |
| `type` | `string`, `number`, `boolean`, `select`, `password`. |
| `default` | Must satisfy the type, min/max, options and pattern. Omit for values that must be chosen. |
| `required` | If true the user must provide a value (or a default must exist). For admin passwords use **no default** plus `generate`, so a strong password is created for every server (or make the variable required with no default if it must be typed). |
| `min` / `max` | Number: value range. String and password: length range. |
| `integer` | Number only: whole numbers only. |
| `options` | Select only: `[{"value": "x", "label": "X"}]`. The default must be one of the values. |
| `pattern` | String/password only: a JavaScript regular expression (unicode mode) the whole value must match. Anchor it with `^...$`. |
| `group` | Heading in the generated settings form. |
| `generate` | String/password only: `{"length": 8..64 (default 20), "charset": "alnum" or "hex" (default "alnum")}`. When the server is created with the value empty or absent, the panel generates it; managers can read it in Settings and regenerate it. Rules: no `default` and no `pattern` together with `generate`; `length` must lie within `min`/`max` if those are set; emptiness never violates `required`. A generated variable is treated as a secret even when its type is `string`. Use it for admin and WebAdmin passwords that nobody should have to invent. |
| `valueMap` | Map from the string value (`"true"`, `"false"`, or an option value) to the text a template receives. |

`password` variables are secret: blanked for viewers and operators, never logged, and the plan file is mode 0600. Only the plan and the container environment ever contain them, so avoid putting secrets in launch arguments when a config file can carry them (arguments are visible in the process list inside the container).

## 6. Launch

```json
"launch": {
  "cwd": "System",
  "command": [
    "./ucc-bin", "server",
    "{{map}}.rom?game=KFmod.KFGameType?MaxPlayers={{maxPlayers}}",
    { "value": "-nohomedir", "if": "someBooleanVariable" }
  ],
  "env": { "HOME": "/data/home" }
}
```

* `cwd`: working directory relative to the install dir (`""` = the install dir itself).
* `command`: an **argv array**, never a shell string. The first element is the program and must be unconditional. For `platform:"windows"` the executor prepends `xvfb-run ... wine`.
* An element may be an object `{"value": "...", "if": "<variable key>"}`; it is included only when that variable is truthy (non-empty and not `false`/`0`).
* A **composite argument** builds one argument from several optional parts: `{"parts": [...], "separator": "?", "if": "<varKey>"}`. Each part is a string or `{"value": "...", "if": "<varKey>"}`. The argument is the parts that are not skipped (a part is skipped when its `if` variable is falsy) joined by `separator` (default empty). The whole argument is omitted when its own `if` is falsy or every part is skipped. `parts` needs at least one entry, and the first element of `command` must still be a plain string.

Before (workaround with a variable that carries its own separators):

```json
"{{map}}?Game={{gameMode}}?MaxPlayers={{maxPlayers}}{{urlOptions}}"
```

After (composite argument; `extraOptions` is an optional free-text variable without a leading `?`):

```json
{ "parts": [ "{{map}}", "Game={{gameMode}}", "MaxPlayers={{maxPlayers}}",
             { "value": "Mutator=KFMutator.KFMutator_MaxPlayersV2", "if": "extendedSlots" },
             { "value": "{{extraOptions}}", "if": "extraOptions" } ],
  "separator": "?" }
```
* `env`: environment variables for the game process. Typical uses: `LD_LIBRARY_PATH`, `SteamAppId`, `HOME` (to make a game keep its saves under `/data`, which is part of the default backups, instead of `/data/steam`, which is not).

## 7. Files: template and ini

Files are written on **every start**, after the install step, so changes to variables take effect on the next start. Paths are relative to the install dir, use `/`, and may not contain `..` or templates.

`when`: `"always"` (default) or `"missing"` (write only if the file does not exist).

### `template`: a whole file

```json
{ "type": "template", "path": "Config/server.cfg", "when": "always",
  "content": "name={{server.name}}\nmaxPlayers={{maxPlayers}}\n" }
```

The file is overwritten with the rendered content. Use `when:"missing"` for a seed that the user (or the game) may edit afterwards.

### `ini`: edit values, keep everything else

```json
{ "type": "ini", "path": "KFGame/Config/LinuxServer-KFGame.ini", "when": "always",
  "set":  [ { "section": "Engine.AccessControl", "key": "AdminPassword", "value": "{{adminPassword}}" } ],
  "list": [ { "section": "OnlineSubsystemSteamworks.KFWorkshopSteamworks",
              "key": "ServerSubscribedWorkshopItems", "valuesFrom": "workshop" } ] }
```

* `set` sets `key=value` in `[section]`: the first existing line is updated in place, otherwise the key is appended to the section (the section is created if needed). Section and key names compare case-insensitively (Unreal ini files are case-insensitive). Comments, unrelated keys and order are preserved; CRLF files stay CRLF.
* `list` writes a *multi-value key* (one `key=value` line per value, for example Unreal's `ServerActors=` or `ServerSubscribedWorkshopItems=`). All existing lines of that key are replaced by the new list. `valuesFrom` is `"workshop"` (the server's Workshop ids; needs a `workshop` section) or `"var:<key>"` (a variable).
* An ini op needs at least one `set` or `list` entry.
* The executor reads files as UTF-8. UTF-16 files (some Unreal games write them) are not supported.

**The file may not exist yet.** An ini op on a missing file creates a *partial* file containing only your keys. For games that generate their config from a default file on first start, that is often fine (Unreal Engine 3 and 4 layer a `Default*.ini` underneath), but for others (Unreal Engine 2) a partial file breaks the game. Seed the full file first from `scripts.postInstall`, which runs on every start *before* the files step:

```json
"scripts": { "postInstall": "[ -f System/KillingFloor.ini ] || cp System/Default.ini System/KillingFloor.ini" }
```

Remember that ini formats differ per game; check what the game actually reads (for example Satisfactory also accepts `-ini:Game:[Section]:Key=Value` on the command line, which avoids needing a file).

## 8. Stop, console, ready, players, query

### `stop`

| Field | Notes |
|---|---|
| `type` | `signal` or `stdin`. |
| `signal` | For `signal`: `SIGINT`, `SIGTERM`, `SIGQUIT`, `SIGHUP`, `SIGUSR1`, `SIGUSR2`, `SIGKILL`. Default `SIGINT`. |
| `command` | For `stdin`: the line written to the game's stdin (for example `quit`). Requires `console.stdin: true`. |
| `timeoutSec` | 1-600. After this the game is killed. Give the game enough time to save. |

### `console`

`{"stdin": true}` attaches the game's stdin so commands typed in the panel console reach the game. Only enable it when the game really reads commands from stdin.

### `ready`

`{"logRegex": "..."}`. The server turns from `starting` to `running` when a log line matches. Without `ready` it counts as running after 20 s of uptime. A regex that never matches leaves the server stuck in `starting`, so only use lines you have seen in a real log.

### `players`

`{"joinRegex": "...", "leaveRegex": "..."}`, both with a named group `(?<name>...)`, matched against the log to build the player list. Prefer `query.a2s` when the game supports it.

### `query`

`{"a2s": {"portId": "query"}}` enables the Steam A2S_INFO/A2S_PLAYER query (UDP) against that port id and fills players, version and map in the stats. The port must be UDP and reachable inside the container network (it does not need to be published).

## 9. Workshop

A `workshop` section adds a Workshop tab (search needs the admin Steam API key; adding by id or URL does not).

```json
"workshop": { "appId": 232090, "install": "config-list" }
```

* `appId` is the **Workshop's** app id, which is often the game's app id and not the dedicated server's (Killing Floor 2: Workshop 232090, server 232130; Killing Floor 1: Workshop 1250, server 215360). An item that belongs to another app is rejected.
* `install: "steamcmd"`: the executor downloads each item with `workshop_download_item` and copies its files into `/data/game/<dir>` (`dir` is required). Removed items are cleaned up again. This only helps if the game finds mods by file presence; it does not edit any activation setting.
* `install: "config-list"`: the executor downloads nothing special; the game itself fetches the items, and you list the ids with an ini `list` entry whose `valuesFrom` is `"workshop"`, or with `{{workshop.ids}}` in a template or argument.
* Changes apply on the next start.

## 10. Web UI proxy

```json
"webui": [ { "id": "webadmin", "label": "WebAdmin", "portId": "web", "path": "/ServerAdmin/",
             "auth": { "type": "basic", "user": "{{adminName}}", "password": "{{adminPassword}}" },
             "minAccess": "manager", "rewrite": true } ]
```

* Each entry becomes a tab with an iframe pointing to `/api/servers/:id/webui/:id/` on the panel. The panel is an authenticated reverse proxy to `http://<container ip>:<containerPort><path>`: the web port should be `publish:false`, so the game's admin interface is never exposed directly.
* `portId` must be a TCP port. `path` is a plain absolute path (no query, no `..`).
* `auth.type: "basic"` makes the panel add the `Authorization` header itself so users do not have to type game credentials (the user name may not contain `:`). `"none"` for interfaces without login.
* `minAccess`: `viewer`, `operator` or `manager` (default) minimum panel role.
* `rewrite: true` rewrites root-absolute URLs in HTML/CSS/JS, `Location` redirects and cookie paths so the site works under the proxy prefix; upstream frame-blocking headers are replaced by `frame-ancestors 'self'`.
* `websocket` (default `false`): set `true` for web interfaces that are single-page apps talking over WebSockets for live data (Eco). The panel then accepts WebSocket upgrades on that UI's proxy URL and bridges them to `ws://<container>:<containerPort><path>`, sending the same basic auth (when configured) with the handshake. Page rewriting also covers `"/ws"`-style string literals, `${location.host}/...` and absolute `ws://<ip:port>` URLs, so keep `rewrite: true`. Leave it `false` for plain HTTP interfaces (the Killing Floor WebAdmins).
* Limits that remain: a 30 s upstream timeout for plain requests, a response size cap, and 502 `webui_unreachable` while the server is not running. Pages that build URLs in unusual ways in JavaScript may still escape the prefix, and a WebSocket whose address is assembled from several variables is not rewritten.

## 11. Scripts and security

`scripts.postInstall` runs on every start before `files`; `scripts.preStart` runs after `files`, right before launch. Both are POSIX `sh` snippets run with `sh -c` in the install directory with the game's environment. Keep them short and idempotent, and avoid `set -e` tricks that turn harmless failures into a fatal start (a non-zero exit aborts the start; end with `true` when a failure is acceptable).

Security notes:

* Definitions are code-adjacent: a script runs inside the game container as uid 1000 and a launch command runs whatever you put there. Only administrators and explicitly granted users can create definitions. Treat imported definitions like any script you download and read them first.
* The container has no access to the host, but it does have network access (SteamCMD needs it) and it can see the plan file, which contains every secret of that server. Do not use `scripts` to ship credentials, and do not echo variables.
* Never hardcode default passwords: use `generate` (or `required` with no `default`) for admin passwords.
* Use `pattern` on string/password variables that are written into URLs, argument fragments or ini files, so users cannot inject extra options or lines.
* Only anonymous SteamCMD login exists; no Steam account credentials are ever stored.

## 12. Testing a definition

1. Create the definition in Admin > Games (or duplicate a built-in one). The editor validates live; fix every listed path/message.
2. Create a server from it. The first start downloads the game, which can take many minutes; the Overview shows the install phase and progress.
3. Read the **Console** (the container log). The executor prints `[servcrafty-steam] phase=install|workshop|configure|launch` and `error=...` markers; the game's own output follows.
4. Check the **Files** tab to see what the executor wrote (config files, ini edits).
5. Iterate: edit the definition, restart the server. The plan is rebuilt on every start, so definition changes apply on the next start. Use "Update/verify game files" if SteamCMD state looks corrupt.
6. Verify the practical behaviour: the server is reachable at the address the panel shows, settings you changed in variables show up in the game, stop saves cleanly (watch how long the game needs and adjust `stop.timeoutSec`), `ready.logRegex` matches exactly once startup is done.
7. Once it works, set `ready`, `players`/`query`, and review every variable description.

Common problems: a game that exits immediately (read the last console lines; missing 32-bit libs or wrong `cwd`); the server runs but nobody can connect (the game advertises a port you did not `mirror`); settings ignored (the game rewrote or ignores that file, or the section/key name is wrong; check case, sections and the file the game really reads); the status stays `starting` (the `ready` regex never matches).

## 13. Worked example: Valheim (example only)

This is an **illustration** of how a typical simple Linux dedicated server maps onto the schema. It was written from public documentation of the Valheim dedicated server (Steam app 896660, anonymous login, start script arguments `-name -port -world -password -public -savedir`, UDP ports 2456-2458, password of at least 5 characters that must not be contained in the server name, saves on `SIGINT`/`SIGTERM`, `LD_LIBRARY_PATH` and `SteamAppId` environment) and has not been run by the ServCrafty authors. It is not shipped as a built-in. Check it against the current game version before using it.

```json
{
  "schema": 1,
  "id": "valheim-example",
  "name": "Valheim (example)",
  "description": "Example definition written for the authoring guide. Valheim dedicated server, Steam app 896660. The server password must be at least 5 characters and must not be contained in the server name.",
  "icon": "https://cdn.cloudflare.steamstatic.com/steam/apps/892970/header.jpg",
  "steam": { "appId": 896660, "branch": "public", "betaPassword": null, "platform": "linux", "login": "anonymous" },
  "resources": { "memoryMb": 4096, "memoryMinMb": 2048, "cpu": 2, "diskMb": 3072 },
  "ports": [
    { "id": "game",  "label": "Game (UDP)",  "protocol": "udp", "containerPort": 2456, "mirror": true, "publish": true, "main": true },
    { "id": "query", "label": "Query (UDP, game port + 1)", "protocol": "udp", "containerPort": 2457, "mirror": true, "publish": true, "offset": { "from": "game", "by": 1 } }
  ],
  "variables": [
    { "key": "serverName", "label": "Server name", "type": "string", "default": "My Valheim Server",
      "required": true, "min": 1, "max": 60, "pattern": "^[A-Za-z0-9 _.-]+$", "group": "Server",
      "description": "Name shown in the server list." },
    { "key": "world", "label": "World name", "type": "string", "default": "Dedicated",
      "required": true, "pattern": "^[A-Za-z0-9_-]+$", "group": "Server",
      "description": "Name of the world file (created on first start)." },
    { "key": "password", "label": "Server password", "type": "password",
      "required": true, "min": 5, "max": 32, "generate": { "length": 12, "charset": "alnum" }, "group": "Access",
      "description": "At least 5 characters and not contained in the server name. Leave empty to have one generated (shown to managers in Settings)." },
    { "key": "public", "label": "Listed publicly", "type": "boolean", "default": false,
      "required": false, "valueMap": { "true": "1", "false": "0" }, "group": "Server",
      "description": "Show the server in the community server list." }
  ],
  "launch": {
    "cwd": "",
    "command": [
      "./valheim_server.x86_64",
      "-nographics", "-batchmode",
      "-name", "{{serverName}}",
      "-port", "{{ports.game}}",
      "-world", "{{world}}",
      "-password", "{{password}}",
      "-public", "{{public}}",
      "-savedir", "/data/saves"
    ],
    "env": { "LD_LIBRARY_PATH": "./linux64", "SteamAppId": "892970" }
  },
  "files": [],
  "stop": { "type": "signal", "signal": "SIGINT", "timeoutSec": 60 },
  "console": { "stdin": false },
  "ready": { "logRegex": "Game server connected" },
  "scripts": { "preStart": "mkdir -p /data/saves" }
}
```

Points to note: the password is a `password` variable with no default whose value is generated when left empty; the one boolean uses `valueMap` to produce `1`/`0`; the game port is `mirror` because the game advertises it; the query port uses `offset` because Valheim's Steam query port is the game port + 1 (Valheim also uses game port + 2, which this example does not publish and which is not needed for the server list); saves go to `/data/saves` so that they are part of the default backups.

## 14. The built-in definitions and their limitations

Everything below was researched from the game wikis, the games' own documentation and well-known community container projects (named per game). Items marked "unverified" could not be confirmed against a running server and should be tested.

### Satisfactory (`satisfactory`)

* Steam app 1690800 (dedicated server), native Linux, anonymous login. About 8-12 GB of disk, 8 GB of RAM recommended (4 GB minimum offered), more for late game or more than 4 players.
* Ports: game 7777 UDP+TCP (UDP game traffic; TCP is the HTTPS API used by the in-game Server Manager) and reliable messaging 8888 TCP (without it clients hang on loading). Both are `mirror` ports so the panel's host ports are the ones the game uses; `-Port` and `-ReliablePort` are passed. Linux launch: `./FactoryServer.sh -Port=... -ReliablePort=... -unattended`.
* `MaxPlayers` is set with the documented command-line override `-ini:Game:[/Script/Engine.GameSession]:MaxPlayers=N`; there are no file operations. The server name, admin password, game password and the world are configured from the in-game **Server Manager**: the first player must "claim" the server there.
* Stops with `SIGINT` (the documented Linux method), 90 s timeout so the world can save.
* Saves live in the game user's home (`~/.config/Epic/FactoryGame/Saved/SaveGames`). The definition sets `HOME=/data/home` so they are inside the default backup scope. Unverified: that this environment is honoured by the server; if saves appear under `/data/steam`, add that directory to your backups.
* No Workshop (mods come from ficsit.app), no A2S query (the server uses its own Lightweight Query API on the game port), so no player list.
* `ready` matches `Server startup time elapsed and saving/level loading is done` or `Game session ID` (from hosting guides; unverified against a real log). If the server never leaves "starting", remove `ready` from your copy.
* Sources: Satisfactory wiki "Dedicated servers" (ports, `-Port`, `-ReliablePort`, `-ini:` override, SIGINT, memory, Server Manager claim) and wolveix/satisfactory-server (ports, `MAXPLAYERS`, memory, runs as uid 1000).

### Killing Floor (`killing-floor`)

* Steam app 215360 (dedicated server; the game is 1250, which is also the Workshop app), native Linux 32-bit (`System/ucc-bin`), anonymous login (as used by LinuxGSM and the K4Rian and Vel-San container projects).
* Launch: `cd System; ./ucc-bin server <Map>.rom?game=KFmod.KFGameType?VACSecured=true?MaxPlayers=N -nohomedir -ini=KillingFloor.ini`. The ini is seeded from `System/Default.ini` by `postInstall` (a partial ini breaks WebAdmin because `ServerActors=UWeb.WebServer` and the `[UWeb.WebServer]` applications would be missing), then edited by `files`: ports (`[URL] Port`, `[IpDrv.UdpGamespyQuery] OldQueryPortNumber`), WebAdmin (`[UWeb.WebServer] bEnabled`, `ListenPort`), name, short name, MOTD, admin name and e-mail (`[Engine.GameReplicationInfo]`), admin and game passwords (`[Engine.AccessControl]`), max players/spectators and `GameDifficulty` (`[Engine.GameInfo]`), `KFGameLength`, `FriendlyFireScale`, `SpecialEventType` (`[KFmod.KFGameType]`), `RedirectToURL` (`[IpDrv.HTTPDownload]`). Key and section names come from the K4Rian `kfdsl` launcher source and the default ini; difficulty values (1, 2, 4, 5, 7) and game length values (0, 1, 2, 3) from the same source.
* `preStart` copies `steamclient.so`, `libtier0_s.so` and `libvstdlib_s.so` from SteamCMD's `linux32` directory next to the binary, as LinuxGSM and kfdsl do, so VAC/Steam authentication works.
* The admin password is generated by the panel when left empty (12 characters, shown to managers in Settings).
* WebAdmin: `[UWeb.WebServer]`, default port 8075, panel proxied with HTTP basic auth using the admin name and password. Unverified: some UT2004-family servers ignore the user name; the definition sends the configured admin name.
* Ports: game 7707/UDP, the Steam query (game port + 1, `offset`) and the GameSpy query 7717/UDP are `mirror` ports; WebAdmin 8075/TCP is internal only.
* Limitations. (1) The Steam query port (game port + 1) is declared with `offset` and mirrored, and A2S is enabled on it (unverified: that KF1 answers A2S there; the server browser itself was not tested). (2) Workshop: files are downloaded with SteamCMD and copied into `System/`, but activation (ServerActors/ServerPackages/mutators) is not automated; use "Extra URL options" or edit the ini. Whether the files of each item are laid out so that a flat copy works is unverified. (3) `ready`, `players` and `console` are not defined because no verified log lines or stdin console behaviour were found; the server counts as running after 20 s. Stop uses `SIGINT` (unverified timing).
* Sources: Tripwire/community docs and guides (app ids, install), LinuxGSM `kfserver` config and `fix_kf` module (launch command, Steam libraries, anonymous install), K4Rian `docker-killingfloor` and `kfdsl` (ini sections/keys, ports, difficulty and length values, default ini), Vel-San `kf1-docker` (ports), PingPerfect KF1 guides (ini sections, WebAdmin `bEnabled`).

### Killing Floor 2 (`killing-floor-2`)

* Steam app 232130 (dedicated server; the game and Workshop app is 232090), anonymous login. Uses the **native Linux server** (`Binaries/Win64/KFGameSteamServer.bin.x86_64`, config files named `LinuxServer-*.ini`), as in LinuxGSM and the hmbsbige container, not Wine (the SPEC mentions Wine as the design assumption; the native binary is simpler and faster, and `platform:"windows"` remains available for a custom definition).
* Launch: `<Map>?Game=<GameClass>?Difficulty=N?GameLength=N?MaxPlayers=N[?Mutator=KFMutator.KFMutator_MaxPlayersV2][?extra]` built as a composite argument with separator `?` -Port=<game> -QueryPort=<query>`. Difficulty 0-3 (Normal, Hard, Suicidal, Hell on Earth), length 0-2 (4/7/10 waves). The server caps players at 6; "Allow more than 6 players" adds the MaxPlayersV2 mutator (as documented for the hmbsbige container).
* Ports: game 7777/UDP and query 27015/UDP are `mirror` ports; WebAdmin 8080/TCP is internal. The Steam port 20560/UDP that community guides publish and NTP (UDP 123, needed only for Weekly Outbreak) are not published. A2S is enabled on the query port.
* Files: `LinuxServer-KFGame.ini` (`[Engine.AccessControl]` AdminPassword/GamePassword, `[Engine.GameReplicationInfo]` ServerName/ShortName, `[KFGame.KFGameInfo]` ServerMOTD), `KFWeb.ini` (`[IpDrv.WebServer]` bEnabled/ListenPort), `LinuxServer-KFEngine.ini` (`[Engine.GameEngine] bUsedForTakeover=FALSE` and the Workshop list `[OnlineSubsystemSteamworks.KFWorkshopSteamworks] ServerSubscribedWorkshopItems`, written from the panel's Workshop tab with `install:"config-list"`). `KFGame/Cache` is created in `preStart` (required for Workshop downloads).
* The admin password is generated by the panel when left empty (20 characters, shown to managers in Settings).
* WebAdmin on `/ServerAdmin/`, panel proxied with basic auth as user `Admin` and the admin password. Unverified: the login mechanism (HTTP basic versus a login form) and the exact user name; if the proxy shows a login page, log in there.
* Limitations: ASCII-only server names (non-ASCII needs a UTF-16 ini); `ready` and `players` are not defined (no verified log lines; running after 20 s, players from A2S); Workshop maps still have to be added to the map cycle; multiplayer-affecting Workshop mods may need manual copying into the game's `BrewedPC` folder (reported by the hmbsbige container's documentation); the UE3 server rewrites its ini files at start, so only keys controlled by variables are stable. Unverified: file encoding of the generated `LinuxServer-*.ini` (the executor reads UTF-8).
* Sources: hmbsbige/kf2server (binary, ports, ini keys, Workshop), LinuxGSM `kf2server` config (appid, binary, query port, config file), Tripwire/community docs and guides (ports, difficulty and length options).

### More built-in games

These ten were written from LinuxGSM's per-game configs, the Pterodactyl game eggs (start commands, "done" log strings, stop commands) and the games' own documentation, each fact checked against at least two of them where one exists. None has been run end to end by the authors: "unverified" marks what to check first on a real server. Common to all of them: anonymous SteamCMD login, native Linux servers, admin and RCON passwords generated with `generate` when left empty (shown to managers in Settings), player-facing passwords optional.

**Source and GoldSrc games** (CS2, CS:GO, CS 1.6, L4D2, TF2, Garry's Mod) share one shape: port 27015 `both` and `mirror` (UDP game and query, TCP RCON), `console.stdin` with `stop` = stdin `quit` (30 s), `query.a2s` on the game port, `+log on` plus the standard Half-Life log lines for the player list (`"Name<id><steamid><team>" entered the game` / `disconnected`), and `ready` on `Connection to Steam servers successful` (also `gameserver Steam ID` for the srcds games), both taken from the Pterodactyl eggs. Optional launch arguments are `{value, if}` pairs. Common limits: a Game Server Login Token (GSLT, a password variable, 32 hex characters) is recommended for CS2, CS:GO, TF2 and Garry's Mod; srcds runs with `-console` and a piped stdin rather than a real tty (unverified); content under `cfg/` and `addons/` lives in the game directory, which the default backups exclude (tick "include game files").

#### Counter-Strike 2 (`counter-strike-2`)
App 730 (the full ~58 GB depot, so `diskMb` 61440), binary `game/bin/linuxsteamrt64/cs2` with `LD_LIBRARY_PATH` pointing at that folder (Pterodactyl egg). Flags `-dedicated -console -usercon`, `game_type`/`game_mode` selects (0/0 Casual, 0/1 Competitive, 0/2 Wingman, 1/0 Arms Race, 1/1 Demolition, 1/2 Deathmatch). Limits: no Workshop maps (they need `-authkey` and `+host_workshop_map`), no player list from logs (CS2 log format differs; A2S only), SourceTV off.

#### Counter-Strike: Global Offensive (`counter-strike-global-offensive`)
App 740, `./srcds_run -game csgo -usercon -strictportbind -tickrate N -maxplayers_override N +game_type +game_mode +mapgroup +map` (LinuxGSM). Legacy game replaced by CS2: unverified whether app 740 stays downloadable.

#### Counter-Strike 1.6 (`counter-strike-1-6`)
App 90 (HLDS) with the `cstrike` mod, `./hlds_run -game cstrike -norestart -pingboost N +maxplayers N +map X` (egg). The `quit` console command makes HLDS restart unless `-norestart` is given, so it is always passed. Install gap: a plain `app_update 90` does not deliver `cstrike`; the definition uses a `postInstall` script that runs SteamCMD itself with `+app_set_config 90 mod cstrike +app_update 90 validate` (up to 3 tries) when `cstrike/liblist.gam` is missing. LinuxGSM instead pre-seeds `appmanifest_90.acf` shared depots and the egg uses the `beta` branch, so this step is unverified; the schema cannot express SteamCMD `app_set_config`.

#### Left 4 Dead 2 (`left-4-dead-2`)
App 222860, no GSLT. Adds `+sv_allow_lobby_connect_only 0` (otherwise only lobby joins work), `mp_gamemode` and `z_difficulty` selects. Workshop addons (VPK files) are not managed.

#### Team Fortress 2 (`team-fortress-2`)
App 232250, `./srcds_run_64` (LinuxGSM; the egg still uses `srcds_run`: duplicate the definition if your install only has the 32-bit launcher), GSLT recommended. No Workshop, no SourceTV.

#### Garry's Mod (`garrys-mod`)
App 4020. Workshop: the panel's Workshop tab is NOT used. The `Workshop collection ID` variable passes `+host_workshop_collection`, which makes the server load the whole collection and makes clients download it; individual `.gma` addons dropped into `garrysmod/addons` also load but clients do not fetch them without a Lua `resource.AddWorkshop`. Counter-Strike: Source content for map textures is not installed. `garrysmod/` (including `data/sv.db`) is not in the default backups.

#### Project Zomboid (`project-zomboid`)
App 380870, Workshop app 108600 with `install: "config-list"` (the game downloads the items listed in the ini). `./start-server.sh -servername servertest -adminpassword ... -cachedir=/data/zomboid -port N -udpport N`, with `Zomboid` linked to `/data/zomboid` so worlds are backed up; stop is stdin `quit` (90 s) and `ready` is `SERVER STARTED` (egg and LinuxGSM stop mode). Ports: 16261 game, 16262 (offset +1), 8766 and 8767 Steam, RCON 27015 internal. Schema gap: `servertest.ini` has no `[section]` headers, which the `ini` file op cannot express, and `WorkshopItems` must be semicolon separated while `{{workshop.ids}}` is comma separated. The definition therefore passes the values as environment variables and a `preStart` shell snippet replaces or appends each `key=value` line (tested with `sh`) and converts the Workshop list to semicolons. Mod ids (`Mods=`) are different from Workshop item ids and are a variable. Unverified: A2S on the game port, exact ini key names for the Steam ports.

#### Rust (`rust`)
App 258550. Ports: 28015 UDP game and 28017 UDP query (mirror), 28016 TCP WebRCON, 28082 TCP Rust+ (mirror). Identity fixed to `rust`, `server` linked to `/data/rust-server` for backups. `ready` is `Server startup complete`, stop is stdin `quit` (120 s). No Workshop: Oxide/uMod are manual uploads. Join/leave regexes (`ip:port/steamid/Name joined [` and `... disconnecting:`) are from memory of real logs and unverified; A2S supplies the count anyway.

#### Unturned (`unturned`)
App 1110390, Workshop app 304930. The game port and the next two UDP ports are allocated with `offset` (+1 Steam query, +2 reserved; unverified). Name, map, mode, perspective, cheats and max players go to `Servers/servcrafty/Server/Commands.dat` (template); Workshop ids are written into `WorkshopDownloadConfig.json` (`"File_IDs": [{{workshop.ids}}]`, valid because the ids are comma separated numbers) and the server downloads them itself, hence `install: "config-list"`. Stop is stdin `shutdown`, `ready` is `Loading level: 100%` (egg). Whether the CLI flags are `-port` or `-Port` is unverified (Unturned parses them case-insensitively).

#### Don't Starve Together (`dont-starve-together`)
App 343050. A cluster token is required. Only the Master shard runs: a Caves shard needs a second process and the executor starts one game process, so caves are not supported (gap). Cluster files are templates under `dst/config/Cluster` (`dst` linked to `/data/dst`); `ready` is not defined because no verified log line was found; join and leave use `[Join Announcement]` and `[Leave Announcement]`. Mods: no panel Workshop (the game downloads mods listed in `mods/dedicated_server_mods_setup.lua` and enables them via `modoverrides.lua`; both are seeded empty with `when: "missing"` and edited with the Files tab) because a per-id line cannot be produced from `{{workshop.ids}}`. Unverified: the 64-bit binary needs `libcurl-gnutls.so.4` in the image.

### Six more built-in games

Sources: LinuxGSM default configs, the Pterodactyl game eggs (start commands, "done" log strings, config keys) and the Eco/Astroneer egg notes. As for the other new games, nothing was run by the authors.

#### Counter-Strike: Source (`counter-strike-source`), Half-Life 2: Deathmatch (`half-life-2-deathmatch`), Left 4 Dead (`left-4-dead`)
Same shape as the other Source games above (port 27015 `both` mirrored, stdin `quit`, A2S, log-line player list, ready on the Steam connection line). Apps 232330 (`-game cstrike`), 232370 (`-game hl2mp`, `-tickrate 66`) and 222840 (`-game left4dead`, `mp_gamemode`, `z_difficulty`, `sv_allow_lobby_connect_only 0`). GSLT is optional for CS:S and HL2:DM and not used for L4D. Sources: LinuxGSM `cssserver`, `hl2dmserver`, `l4dserver`; Pterodactyl eggs for CS:S (`gameserver Steam ID`) and HL2:DM (`Connection to Steam servers successful.`). L4D's ready line and `z_difficulty` values are assumed to match L4D2.

#### Quake Live (`quake-live`)
App 349090, `./qzeroded.x64` with `LD_LIBRARY_PATH=./linux64` (egg; LinuxGSM wraps it in `run_server_x64.sh`). Everything is passed as `+set` arguments: `net_port`, `sv_hostname`, `sv_serverType`, `sv_maxClients`, `sv_fps`, `g_password` (only when set), ZeroMQ RCON (`zmq_rcon_enable/port/password`, TCP 28888 published, generated password) and `+map <map> <factory>`. `ready` is `zmq stats and rcon passwords updated` and stop is stdin `quit` (egg). Unverified: A2S answering on the game port, the `+map <map> <factory>` form for every factory, and that the ZeroMQ stats port can stay disabled.

#### Eco (`eco`) - unverified areas flagged
App 739590, native Linux self-contained .NET binary `./EcoServer -nogui` (LinuxGSM) with `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` so no ICU library is needed (assumption). Ports: game 3000 and the web server 3001, both published and `mirror`: Eco clients read the server info from the web port, so it cannot be kept private. `Configs/Network.eco` (JSON) is written from a template on every start with the keys used by the Pterodactyl egg (`GameServerPort`, `WebServerPort`, `PublicServer`, `Password`, `UPnPEnabled`, `Description`, `DetailedDescription`, `MaxConnections`, `DiscordAddress`, `ServerCategory`); the JSON file op does not exist, so this is a whole-file template, text variables forbid `"` and `\`, and all other Network.eco keys revert to the game defaults on every start. `ready` is `Web Server now listening on` and stop is stdin `exit` (egg); LinuxGSM stops with Ctrl-C.
* Web UI: one `webui` entry on port 3001, path `/`, `auth: none` (Eco's own web login/token, if any, is untouched), `rewrite: true` and `websocket: true` because the interface is a single-page app that receives live data over a WebSocket. Unverified: that the rewriting and the WebSocket bridge cope with Eco's actual page and socket address; the same page is reachable directly at the published web port.
* Mods: Eco mods are not Steam Workshop items (no `workshop` section); upload them to `Mods/` with the Files tab. The world in `Storage/` is linked to `/data/eco-storage` (backed up); `Configs/` (including `Users.eco` for admins) is not.
* SLG user token: `-userToken=` (LinuxGSM) is an optional password variable; the egg instead passes SLG account credentials, which a definition should not store. Whether an unauthenticated server can be listed publicly is unverified.

#### Astroneer (`astroneer`) - Wine path, entirely unverified
App 728470 is Windows-only, so `platform: "windows"`: the executor installs the Windows depot and runs `xvfb-run ... wine ./Astro/Binaries/Win64/AstroServer-Win64-Shipping.exe -log`. The Pterodactyl egg runs the same executable under Proton, not Wine, so whether it starts under plain Wine is the first thing to test. Config (egg keys): `Astro/Saved/Config/WindowsServer/Engine.ini` (`[URL] Port`, `[SystemSettings] net.AllowEncryption=False`) and `AstroServerSettings.ini` (`[/Script/Astro.AstroServerSettings]` `PublicIP`, `ServerName`, `ServerPassword`, `OwnerName`, `OwnerGuid`, `PlayerProperties=(PlayerFirstJoinName="...",PlayerCategory=Admin,PlayerGuid="...",PlayerRecentJoinName="")`). The server needs the public IPv4 and the owner's name and SteamID64, so these are required variables; the owner is made administrator, which is how a server is claimed here (when the owner fields are left blank the game is reported to let the first joining player claim it, but a blank owner also makes the generated `PlayerProperties` invalid, so this definition always requires them). Port 8777 UDP+TCP is mirrored. Players must set `net.AllowEncryption=False` in their own `Engine.ini` (`%LocalAppData%\Astro\Saved\Config\WindowsNoEditor\Engine.ini`) because the server turns encryption off (egg README), and the host firewall must forward 8777.
* `ready`, `players`, `query` and the console are not defined: the egg's "done" string (`nable to use setpriority safely`) is a Proton/Wine message, not a game line, and the Windows-style Astroneer console commands (`DS...`) cannot be reached without a Windows console. Stop is SIGINT to the Wine process group (the egg also stops with Ctrl-C); a clean save on stop is unverified, so rely on the game's autosave.
* The ini ops write partial files when the game has not generated them yet; the game is expected to fill in the rest (unverified). `Astro/Saved` is linked to `/data/astro-saved` so saves are backed up (Wine following the symlink is assumed).
* Resources: the egg says at least 700 MiB; 3 GB default with Wine overhead is a guess.

### Schema gaps found while writing the built-ins

* A derived port was missing at first; it is now covered by `offset` (used for Killing Floor 1's Steam query port).
* No verified per-file encoding option (UTF-16 ini files) and no ini "create from default" operation (worked around with `scripts.postInstall`).
* The ini file op has no support for files without section headers (Project Zomboid servertest.ini): worked around with environment variables and a preStart snippet.
* SteamCMD options beyond app_update/beta (e.g. app_set_config for Counter-Strike 1.6) are not expressible: worked around with a postInstall script that calls SteamCMD.
* One game process only: Don't Starve Together caves (second shard) are not supported.
* No per-item loop in templates, so DST modoverrides.lua cannot be generated from the Workshop list.
* No JSON file operation: Eco Network.eco is a whole-file template that is rewritten on every start.
* Process exit and console for Wine-hosted Windows servers (Astroneer) are best-effort: no way to send a Windows console command or Ctrl-C reliably.
