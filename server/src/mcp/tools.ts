import { grants, ruleFor, type KeyLimits } from '../lib/apiScopes.js';
import { allOperations, inputSchemaOf, paramsOf } from './openapi.js';

/**
 * MCP tools (v0.6.0). A tool is an API operation with a friendly name: it runs through the normal REST API with the caller's
 * own API key, so scopes, server limits, ownership/sharing checks, quotas and validation are exactly those of the API.
 */

export interface ToolDef {
  name: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** OpenAPI path template (`/servers/{id}/power`). */
  path: string;
  destructive?: boolean;
  /** Long results keep their end (logs: the newest lines) instead of their start. */
  keepTail?: boolean;
}

const T = (name: string, method: ToolDef['method'], path: string, description: string, destructive = false, keepTail = false): ToolDef => ({ name, method, path, description, destructive, keepTail });

export const TOOLS: readonly ToolDef[] = [
  // identity and catalogue
  T('whoami', 'GET', '/auth/me', 'Show who this API key acts as and what it may do (granted scopes and the servers it is limited to, if any).'),
  T('list_games', 'GET', '/games', 'List the games that can be hosted (Minecraft variants, Terraria and SteamCMD game definitions) with their ports, variables and settings.'),
  T('get_game', 'GET', '/games/{id}', 'Full definition of one SteamCMD game (variables you can set when creating a server of it).'),
  T('minecraft_versions', 'GET', '/catalog/minecraft/versions', 'Minecraft versions available for a server type.'),
  T('search_catalog', 'GET', '/catalog/search', 'Search Modrinth/CurseForge for mods, plugins and modpacks.'),
  // servers
  T('list_servers', 'GET', '/servers', 'List the servers this key can see, with status, game, ports and the access level.'),
  T('get_server', 'GET', '/servers/{id}', 'Details and configuration of one server, including its current status.'),
  T('create_server', 'POST', '/servers', 'Create a server (stopped). Use list_games first for the game types and variables; start it afterwards with server_power.'),
  T('update_server', 'PATCH', '/servers/{id}', 'Change a server: name, memory, CPU, ports, Minecraft/Terraria/Steam settings. Some changes need a restart (the response says which).'),
  T('delete_server', 'DELETE', '/servers/{id}', 'Delete a server and ALL its data (worlds, files, backups). Cannot be undone.', true),
  T('clone_server', 'POST', '/servers/{id}/clone', 'Clone a server (settings and, optionally, files).'),
  T('server_power', 'POST', '/servers/{id}/power', 'Start, stop, restart or kill a server. Start/restart return quickly while it boots: poll server_stats for the status.'),
  T('server_stats', 'GET', '/servers/{id}/stats', 'Current status, CPU, memory and uptime of a server.'),
  T('get_logs', 'GET', '/servers/{id}/logs', 'Read the last lines of the server console log (with timestamps in `times`).', false, true),
  T('send_command', 'POST', '/servers/{id}/command', 'Send a command to the running server console (RCON or stdin) and get its output when the game returns one.', true),
  T('list_players', 'GET', '/servers/{id}/players', 'Players online and, for Minecraft, the player lists.'),
  T('player_action', 'POST', '/servers/{id}/players/{name}/{action}', 'Kick, ban, pardon, op, deop, whitelist or unwhitelist a player.'),
  T('get_properties', 'GET', '/servers/{id}/properties', 'Read server.properties of a Minecraft server.'),
  T('set_properties', 'PUT', '/servers/{id}/properties', 'Change server.properties values of a Minecraft server (applied on the next restart).'),
  // files
  T('list_files', 'GET', '/servers/{id}/files', "List a directory of a server's files."),
  T('read_file', 'GET', '/servers/{id}/files/content', 'Read a text file of a server (configs, logs, scripts).'),
  T('write_file', 'PUT', '/servers/{id}/files/content', 'Create or overwrite a text file of a server.', true),
  T('make_directory', 'POST', '/servers/{id}/files/mkdir', 'Create a directory in a server.'),
  T('rename_file', 'POST', '/servers/{id}/files/rename', 'Rename or move a file or directory in a server.', true),
  T('delete_file', 'DELETE', '/servers/{id}/files', 'Delete a file or directory of a server.', true),
  // backups
  T('list_backups', 'GET', '/servers/{id}/backups', 'List the backups of a server.'),
  T('create_backup', 'POST', '/servers/{id}/backups', 'Create a backup of a server now.'),
  T('restore_backup', 'POST', '/servers/{id}/backups/{bid}/restore', 'Restore a backup over the server data (the server is stopped first). Overwrites current files.', true),
  T('delete_backup', 'DELETE', '/servers/{id}/backups/{bid}', 'Delete a backup.', true),
  // schedules
  T('list_schedules', 'GET', '/servers/{id}/schedules', 'List the scheduled tasks (restarts, backups, commands) of a server.'),
  T('create_schedule', 'POST', '/servers/{id}/schedules', 'Create a scheduled task for a server.'),
  T('update_schedule', 'PATCH', '/schedules/{id}', 'Change a scheduled task (cron, enabled, action).'),
  T('delete_schedule', 'DELETE', '/schedules/{id}', 'Delete a scheduled task.', true),
  T('run_schedule', 'POST', '/schedules/{id}/run', 'Run a scheduled task now.'),
  // mods, plugins and workshop
  T('list_mods', 'GET', '/servers/{id}/mods', 'List installed mods/plugins of a Minecraft server.'),
  T('install_mod', 'POST', '/servers/{id}/mods/install', 'Install a mod or plugin from Modrinth/CurseForge on a Minecraft server.'),
  T('delete_mod', 'DELETE', '/servers/{id}/mods/{file}', 'Remove an installed mod or plugin.', true),
  T('steam_update', 'POST', '/servers/{id}/steam/update', 'Check for and install updates of a SteamCMD game server.'),
  T('workshop_search', 'GET', '/workshop/search', 'Search the Steam Workshop for a game.'),
  T('workshop_list', 'GET', '/servers/{id}/workshop', 'List the Workshop items of a SteamCMD server.'),
  T('workshop_add', 'POST', '/servers/{id}/workshop', 'Add a Steam Workshop item to a server (downloaded on the next start).'),
  T('workshop_remove', 'DELETE', '/servers/{id}/workshop/{itemId}', 'Remove a Workshop item from a server.', true),
  // panel updates (administrators)
  T('update_status', 'GET', '/admin/update', 'Panel version, whether a newer release exists, whether this install can self-update (canUpdate / cannotUpdateReason) and the state of a running update.'),
  T('check_for_updates', 'POST', '/admin/update/check', 'Ask GitHub for the latest ServCrafty release now (rate limited: 6 per 10 minutes).'),
  T('apply_update', 'POST', '/admin/update/apply', 'Update the panel to the latest release (or `version`). The panel RESTARTS (a minute of downtime for the API and web UI); game servers keep running. Returns 202: poll update_status until state is succeeded/failed.', true),
  T('rollback_update', 'POST', '/admin/update/rollback', 'Go back to the version installed before the last update. The panel restarts.', true),
  T('update_log', 'GET', '/admin/update/log', 'Output of the running or last update (the end of it when long; use the returned offset to read on).', false, true),
  // templates
  T('list_templates', 'GET', '/templates', 'List server templates.'),
  T('create_server_from_template', 'POST', '/templates/{id}/instantiate', 'Create a new server from a template.'),
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const toolByName = (name: string): ToolDef | undefined => TOOL_BY_NAME.get(name);

/** Scope a tool needs (`any` for identity-only tools). */
export function scopeOfTool(t: ToolDef): string | null {
  const rule = ruleFor(t.method, t.path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1'));
  return rule && rule !== 'session' ? rule : null;
}

/** May a key with these limits use the tool at all? (server restrictions are checked per call by the API) */
export function toolAllowed(limits: KeyLimits, t: ToolDef): boolean {
  const rule = scopeOfTool(t);
  if (!rule) return false;
  return rule === 'any' || grants(limits.scopes, rule);
}

// ---- the two generic tools ----

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const GENERIC_TOOLS = [
  {
    name: 'list_api_endpoints',
    description:
      'List the documented REST endpoints this key may call (method, path, summary, required scope). Use it to find an operation that has no dedicated tool, then call it with api_request.',
    inputSchema: { type: 'object', properties: { search: { type: 'string', description: 'Only endpoints whose path or summary contain this text.' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'api_request',
    description:
      'Call any ServCrafty REST endpoint (path relative to /api, e.g. "/servers/<id>/l4d2/maps"). Same permissions as every other tool: the key scopes and server limits apply. Use list_api_endpoints to discover endpoints. Not available: login, account and token management.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: [...METHODS] },
        path: { type: 'string', description: 'Path under /api, starting with "/". Query string allowed.' },
        body: { type: 'object', description: 'JSON body for POST/PUT/PATCH.' },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
] as const;

/** Paths `api_request` refuses even for a full key (interactive/identity management). */
export function apiRequestPathProblem(p: string): string | null {
  if (!p.startsWith('/') || p.startsWith('//')) return 'path must start with a single "/" and be relative to /api';
  if (/[\\\s]|\.\.|%2e|%2f|%5c/i.test(p.split('?')[0]!)) return 'invalid path';
  const base = p.split('?')[0]!;
  if (/^\/(auth|account|internal)(\/|$)/.test(base)) return 'this endpoint is not available through MCP';
  if (/^\/servers\/[^/]+\/webui(\/|$)/.test(base)) return 'the web UI proxy is not available through MCP';
  return null;
}

/** Splits a tool's flat arguments back into path parameters, query string and JSON body. */
export function buildRequest(t: ToolDef, args: Record<string, unknown>): { url: string; body: Record<string, unknown> | null } {
  const params = paramsOf(t.method, t.path);
  const path = params.filter((p) => p.in === 'path');
  const query = params.filter((p) => p.in === 'query');
  const used = new Set([...path, ...query].map((p) => p.name));
  let url = t.path;
  for (const p of path) {
    const v = args[p.name];
    if (v === undefined || v === null || v === '') throw new ArgError(`Missing required argument "${p.name}"`);
    url = url.replace(`{${p.name}}`, encodeURIComponent(String(v)));
  }
  const qs = new URLSearchParams();
  for (const p of query) {
    const v = args[p.name];
    if (v !== undefined && v !== null) qs.set(p.name, String(v));
  }
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!used.has(k)) body[k] = v;
  const hasBody = t.method !== 'GET' && t.method !== 'DELETE';
  return { url: url + (qs.size ? `?${qs}` : ''), body: hasBody ? body : null };
}

export class ArgError extends Error {}

/** Tool descriptors for tools/list. */
export function describeTool(t: ToolDef) {
  const scope = scopeOfTool(t);
  return {
    name: t.name,
    description: `${t.description}${scope && scope !== 'any' ? ` [scope: ${scope}]` : ''}`,
    inputSchema: inputSchemaOf(t.method, t.path),
    annotations: { readOnlyHint: t.method === 'GET', destructiveHint: !!t.destructive || t.method === 'DELETE', idempotentHint: t.method === 'GET' || t.method === 'PUT' || t.method === 'DELETE' },
  };
}

/** Endpoints listing for list_api_endpoints, limited to what the key may call. */
export function listEndpoints(limits: KeyLimits, search?: string) {
  const q = search?.toLowerCase().trim();
  return allOperations()
    .map((o) => ({ ...o, scope: ruleFor(o.method, toPattern(o.path)) }))
    .filter((o) => o.scope && o.scope !== 'session' && !/^\/(auth|account|internal)\//.test(o.path) && !o.path.includes('/webui/'))
    .filter((o) => o.scope === 'any' || grants(limits.scopes, o.scope!))
    .filter((o) => !q || o.path.toLowerCase().includes(q) || o.summary.toLowerCase().includes(q))
    .map((o) => ({ method: o.method, path: o.path, summary: o.summary, scope: o.scope }));
}

const toPattern = (template: string) => template.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
