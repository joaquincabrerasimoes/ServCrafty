# ServCrafty for AI agents: API keys, permissions and MCP

This guide explains how to give an AI agent (Claude, Cursor, a script, any MCP client) controlled access to your ServCrafty panel: create servers, configure and start them, read logs, send console commands, manage files, backups and schedules.

- Panel: `{{BASE_URL}}`
- MCP endpoint: `{{BASE_URL}}/mcp`
- REST API: `{{BASE_URL}}/api` (see the API guide and the OpenAPI file in the same download menu)

There are three pieces:

1. **API keys with permissions.** A key says exactly what the agent may do and on which servers.
2. **An MCP server built into the panel.** Nothing to install: the agent connects to `{{BASE_URL}}/mcp` with the key.
3. **A skill (`SKILL.md`)** that teaches an agent how to use ServCrafty well. Download it from the same menu.

---

## 1. Create a key with the permissions you want

1. Sign in to the panel, open **Account** > **API keys**.
2. Give it a name that says who uses it (for example `claude-code-laptop`).
3. Pick a **preset** or tick the permissions one by one (see the table below).
4. Optionally **limit it to some servers** and set an **expiry**.
5. Press **Create** and copy the key. **It is shown only once.**

Revoke or edit a key at any time from the same list. Changes apply immediately. Editing and creating keys needs a normal browser login: a key can never create keys or widen itself.

### A key never does more than its owner

The permissions of a key are an *upper bound that narrows* what its owner can do. The panel still applies ownership, sharing levels (viewer / operator / manager) and the administrator role on every request. A key with `servers:delete` that belongs to a user who only has *viewer* access to a server still cannot delete it. Keys of administrators can hold the `admin:*` permissions; keys of other users cannot.

### Presets

| Preset | What it allows |
| --- | --- |
| **read-only** | Look at servers, logs, players, backups, schedules and the game catalogue. Cannot change anything. |
| **operator** | Read-only, plus start/stop servers, run console commands, manage players, backups and schedules. |
| **manager** | Create and configure servers, files, mods and backups. Cannot delete servers, restore backups, share servers or administer the panel. |
| **full** | Everything the owner can do (this is what every key had before v0.6.0). |

### Permissions (scopes)

`X:write` also grants `X:read` of the same resource. `files:*` grants every action of `files`. `*` grants everything.

| Scope | Risk | Allows |
| --- | --- | --- |
| `servers:read` | low | List servers; read details, status, resource usage, settings, properties, icon |
| `servers:create` | medium | Create, import and clone servers, create from templates |
| `servers:configure` | medium | Change settings, properties, ports, resources, icon, BlueMap, Steam updates, Terraria worlds |
| `servers:power` | medium | Start, stop, restart, kill |
| `servers:delete` | high | Delete servers and all their data |
| `logs:read` | low | Read the console log (also live over the WebSocket) |
| `console:execute` | high | Send console commands (RCON / stdin), Left 4 Dead 2 controls |
| `players:read` | low | Online players, whitelist, operators, bans |
| `players:manage` | medium | Kick, ban, op, whitelist |
| `files:read` | medium | Browse, read and download server files |
| `files:write` | high | Create, edit, upload, rename, delete server files |
| `backups:read` | low | List and download backups |
| `backups:write` | medium | Create and delete backups |
| `backups:restore` | high | Restore a backup over the current data |
| `mods:read` | low | List mods, plugins, Workshop items, updates |
| `mods:write` | high | Install, update, remove mods, plugins, Workshop items (runs third-party code) |
| `schedules:read` / `schedules:write` | low / medium | List / manage scheduled tasks |
| `webhooks:read` / `webhooks:write` | low / medium | List / manage webhooks |
| `shares:read` / `shares:write` | low / high | See / change who a server is shared with |
| `templates:read` / `templates:write` | low / medium | List / manage server templates |
| `games:read` | low | Game catalogue, Minecraft versions, Workshop search |
| `games:write` | critical | Create/change/delete custom game definitions |
| `admin:read` / `admin:write` | medium / critical | Administrator only: read administration data / manage users, settings, games |
| `admin:update` | critical | Administrator only: update the panel to a new release, check for updates, roll back |

### Limit a key to some servers

Choose "only these servers" when creating the key. The key then only sees and touches those servers (the server list is filtered, other servers answer `403 server_not_allowed`). Panel-wide endpoints (users, administration, panel-wide webhooks) are not available to such keys. **Servers the key creates are added to its list automatically**, so an agent can build and manage its own servers without seeing yours.

### What a key can never do

Passwords, two-factor settings, passkeys and key management need an interactive login and answer `403 session_required` with a key. The web UI proxy and the internal shutdown hook are not available to keys either. Any endpoint added in the future is closed to limited keys until it is given a permission.

---

## 2. Connect an MCP client

The MCP server speaks *Streamable HTTP* (stateless). Authenticate with `Authorization: Bearer scf_...` on every request. Browser cookies are not accepted. Use HTTPS (your public URL) so the key is not readable on the way.

### Claude Code

```bash
claude mcp add --transport http servcrafty {{BASE_URL}}/mcp --header "Authorization: Bearer scf_xxxxxxxx"
```

Put `--scope user` to make it available in every project. Then ask for example: *"List my ServCrafty servers and show the last 50 log lines of the Minecraft one."*

### Cursor, VS Code and other clients with HTTP support

```json
{
  "mcpServers": {
    "servcrafty": {
      "url": "{{BASE_URL}}/mcp",
      "headers": { "Authorization": "Bearer scf_xxxxxxxx" }
    }
  }
}
```

### Clients that only speak stdio (for example Claude Desktop)

Use the `mcp-remote` bridge:

```json
{
  "mcpServers": {
    "servcrafty": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "{{BASE_URL}}/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer scf_xxxxxxxx" }
    }
  }
}
```

### Test it by hand

```bash
curl -s {{BASE_URL}}/mcp \
  -H "Authorization: Bearer scf_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`tools/list` shows only the tools the key may use. Without a key the endpoint answers `401`.

---

## 3. Tools

Every tool is a normal API operation with a friendly name and exact argument validation (it is generated from the OpenAPI file). Tools run with the caller's own key, so scopes, server limits and access checks are those of the API.

| Group | Tools |
| --- | --- |
| Identity and catalogue | `whoami`, `list_games`, `get_game`, `minecraft_versions`, `search_catalog` |
| Servers | `list_servers`, `get_server`, `create_server`, `update_server`, `delete_server`, `clone_server`, `server_power`, `server_stats` |
| Console and players | `get_logs`, `send_command`, `list_players`, `player_action`, `get_properties`, `set_properties` |
| Files | `list_files`, `read_file`, `write_file`, `make_directory`, `rename_file`, `delete_file` |
| Backups | `list_backups`, `create_backup`, `restore_backup`, `delete_backup` |
| Schedules | `list_schedules`, `create_schedule`, `update_schedule`, `delete_schedule`, `run_schedule` |
| Mods and Workshop | `list_mods`, `install_mod`, `delete_mod`, `steam_update`, `workshop_search`, `workshop_list`, `workshop_add`, `workshop_remove` |
| Templates | `list_templates`, `create_server_from_template` |
| Panel updates (admin) | `update_status`, `check_for_updates`, `apply_update`, `rollback_update`, `update_log` |
| Anything else | `list_api_endpoints` (what this key may call), `api_request` (call any documented endpoint) |

Destructive tools are marked with the MCP `destructiveHint` annotation, so clients ask for confirmation.

Errors come back as tool errors with the HTTP status and the API error code (`insufficient_scope`, `server_not_allowed`, `quota_exceeded`, `no_free_ports`, `game_not_allowed`, ...), which an agent can act on.

---

## 4. Good practice

- **Least privilege.** Start with *read-only* or *operator*; give *manager* to an agent that should build servers. Reserve `servers:delete`, `backups:restore`, `files:write`, `mods:write`, `shares:write`, `games:write` and `admin:*` (including `admin:update`) for cases that need them.
- **One key per agent or machine**, named after it, with an expiry. Revoke it when you stop using it.
- **Limit it to the servers it needs**, or let it create its own (they are added to the key automatically).
- Everything a key does is written to the audit log under your name, with the key's action (for example `server.power.start`).
- Treat a key like a password. If it leaks, delete it in Account > API keys: it stops working immediately.
- Disabling a user deletes all of that user's keys.

---

## 5. Troubleshooting

| Symptom | Cause |
| --- | --- |
| `401` on `/mcp` | Missing, wrong, expired or revoked key; or the account is LAN-only and the request comes from outside the LAN. |
| `403 insufficient_scope` | The key lacks the permission named in the error (`error.details.required`). Edit the key in Account > API keys. |
| `403 server_not_allowed` | The key is limited to other servers. |
| `403 session_required` | The action needs an interactive login (keys, passwords, 2FA). |
| `403 scope_not_mapped` | A limited key called an endpoint that has no permission yet. Use a `*` key or open an issue. |
| The tool list is shorter than expected | `tools/list` only shows tools the key may use. |
| Client cannot connect | The client does not support HTTP MCP: use the `mcp-remote` bridge. |
