/**
 * API key permissions (v0.6.0).
 *
 * A key has a list of scopes (`resource:action`) and optionally a list of server ids it may touch. A key can never do more than
 * its owner can: the panel's own access checks (ownership, sharing level, admin role) still run on every request, the scopes only
 * narrow them further.
 *
 * - `*` grants everything the owner may do (what every key had before v0.6.0).
 * - `files:*` grants every action of a resource.
 * - `X:write` also grants `X:read` of the same resource.
 */

export type ScopeRisk = 'low' | 'medium' | 'high' | 'critical';

export interface ScopeDef {
  id: string;
  group: string;
  risk: ScopeRisk;
  /** Only keys of administrators may hold it. */
  adminOnly?: boolean;
  description: string;
}

export const SCOPES: readonly ScopeDef[] = [
  { id: 'servers:read', group: 'servers', risk: 'low', description: 'List servers and read their details, status, resource usage, settings, properties and icon.' },
  { id: 'servers:create', group: 'servers', risk: 'medium', description: 'Create, import and clone servers (also from templates). Servers created by a key limited to some servers are added to that key automatically.' },
  { id: 'servers:configure', group: 'servers', risk: 'medium', description: 'Change server settings, properties, ports, resources, icon, BlueMap, Steam updates and Terraria worlds.' },
  { id: 'servers:power', group: 'servers', risk: 'medium', description: 'Start, stop, restart and kill servers.' },
  { id: 'servers:delete', group: 'servers', risk: 'high', description: 'Delete servers and all their data.' },
  { id: 'logs:read', group: 'console', risk: 'low', description: 'Read the console log (including the live log over the WebSocket).' },
  { id: 'console:execute', group: 'console', risk: 'high', description: 'Send commands to the server console (RCON / stdin) and use the Left 4 Dead 2 controls.' },
  { id: 'players:read', group: 'players', risk: 'low', description: 'List online players, whitelist, operators and bans.' },
  { id: 'players:manage', group: 'players', risk: 'medium', description: 'Kick, ban, op and whitelist players.' },
  { id: 'files:read', group: 'files', risk: 'medium', description: 'Browse, read and download the files of a server (world data, configs).' },
  { id: 'files:write', group: 'files', risk: 'high', description: 'Create, edit, upload, rename and delete the files of a server.' },
  { id: 'backups:read', group: 'backups', risk: 'low', description: 'List and download backups.' },
  { id: 'backups:write', group: 'backups', risk: 'medium', description: 'Create and delete backups.' },
  { id: 'backups:restore', group: 'backups', risk: 'high', description: 'Restore a backup over the current server data.' },
  { id: 'mods:read', group: 'mods', risk: 'low', description: 'List mods, plugins, Workshop items and available updates.' },
  { id: 'mods:write', group: 'mods', risk: 'high', description: 'Install, update and remove mods, plugins and Workshop items (this runs third-party code on the server).' },
  { id: 'schedules:read', group: 'schedules', risk: 'low', description: 'List scheduled tasks.' },
  { id: 'schedules:write', group: 'schedules', risk: 'medium', description: 'Create, change, delete and run scheduled tasks.' },
  { id: 'webhooks:read', group: 'webhooks', risk: 'low', description: 'List webhooks.' },
  { id: 'webhooks:write', group: 'webhooks', risk: 'medium', description: 'Create, change, delete and test webhooks.' },
  { id: 'shares:read', group: 'sharing', risk: 'low', description: 'See who a server is shared with and look up users.' },
  { id: 'shares:write', group: 'sharing', risk: 'high', description: 'Share servers with other users or remove their access.' },
  { id: 'templates:read', group: 'templates', risk: 'low', description: 'List server templates.' },
  { id: 'templates:write', group: 'templates', risk: 'medium', description: 'Save and delete server templates.' },
  { id: 'games:read', group: 'games', risk: 'low', description: 'Read the game catalogue, definitions, Minecraft versions and search the Steam Workshop.' },
  { id: 'games:write', group: 'games', risk: 'critical', description: 'Create, change and delete custom game definitions (they decide what runs inside game containers).' },
  { id: 'admin:read', group: 'admin', risk: 'medium', adminOnly: true, description: 'Read administration data: users, settings, ports, system information, processes, update status.' },
  { id: 'admin:write', group: 'admin', risk: 'critical', adminOnly: true, description: 'Administer the panel: manage users, change settings, enable or disable games.' },
  { id: 'admin:update', group: 'admin', risk: 'critical', adminOnly: true, description: 'Update the panel to a new version, check for updates and roll back (the panel restarts; game servers keep running).' },
] as const;

export const SCOPE_IDS: readonly string[] = SCOPES.map((s) => s.id);
const SCOPE_BY_ID = new Map(SCOPES.map((s) => [s.id, s]));

export interface ScopePreset {
  id: string;
  description: string;
  scopes: string[];
}

export const PRESETS: readonly ScopePreset[] = [
  { id: 'read-only', description: 'Look at servers, logs, players, backups and schedules. Cannot change anything.', scopes: ['servers:read', 'logs:read', 'players:read', 'backups:read', 'mods:read', 'schedules:read', 'webhooks:read', 'templates:read', 'games:read'] },
  {
    id: 'operator',
    description: 'Read-only plus start/stop servers, run console commands, manage players, backups and schedules.',
    scopes: ['servers:read', 'servers:power', 'logs:read', 'console:execute', 'players:read', 'players:manage', 'backups:read', 'backups:write', 'mods:read', 'schedules:read', 'schedules:write', 'webhooks:read', 'templates:read', 'games:read'],
  },
  {
    id: 'manager',
    description: 'Create and configure servers, files, mods and backups. Cannot delete servers, restore backups, share or administer.',
    scopes: ['servers:read', 'servers:create', 'servers:configure', 'servers:power', 'logs:read', 'console:execute', 'players:read', 'players:manage', 'files:write', 'backups:read', 'backups:write', 'mods:write', 'schedules:write', 'webhooks:read', 'templates:write', 'games:read'],
  },
  { id: 'full', description: 'Everything the owner of the key can do (including administration for an administrator).', scopes: ['*'] },
] as const;

/** Returns the first problem with a list of scopes, or null when it is valid. */
export function scopeProblem(scopes: readonly string[], role: 'admin' | 'user'): string | null {
  if (!scopes.length) return 'A key needs at least one scope';
  for (const s of scopes) {
    if (s === '*') continue;
    if (s.endsWith(':*')) {
      const group = s.slice(0, -2);
      if (!SCOPES.some((d) => d.id.split(':')[0] === group)) return `Unknown scope "${s}"`;
      if (role !== 'admin' && group === 'admin') return 'Only administrators can use admin scopes';
      continue;
    }
    const def = SCOPE_BY_ID.get(s);
    if (!def) return `Unknown scope "${s}"`;
    if (def.adminOnly && role !== 'admin') return 'Only administrators can use admin scopes';
  }
  return null;
}

/** Canonical form: de-duplicated, `*` swallows everything else, `x:*` swallows its members. */
export function normalizeScopes(scopes: readonly string[]): string[] {
  const set = new Set(scopes);
  if (set.has('*')) return ['*'];
  for (const s of [...set]) if (s.endsWith(':*')) for (const o of [...set]) if (o !== s && o.startsWith(s.slice(0, -1))) set.delete(o);
  return [...set].sort();
}

/** Does a key holding `held` satisfy the `needed` scope? */
export function grants(held: readonly string[], needed: string): boolean {
  if (held.includes('*') || held.includes(needed)) return true;
  const [res, action] = needed.split(':');
  if (held.includes(`${res}:*`)) return true;
  return action === 'read' && held.includes(`${res}:write`);
}

/** Subset of `catalog` scopes that `held` grants (used to tell an agent what it may use). */
export function expandScopes(held: readonly string[]): string[] {
  return SCOPE_IDS.filter((s) => grants(held, s));
}

// ---------------------------------------------------------------------------------------------------------------------
// Route -> scope table
// ---------------------------------------------------------------------------------------------------------------------

/**
 * - a scope id: the key needs it;
 * - `any`: every valid key may call it (identity, quota, public information);
 * - `session`: never with a key (interactive actions, loopback-only hooks, the web UI proxy).
 */
export type RouteRule = string;

const R = (s: string): [string, RouteRule][] =>
  s
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [method, path, rule] = l.split(/\s+/);
      return [`${method} ${path}`, rule!];
    });

export const ROUTE_RULES: ReadonlyMap<string, RouteRule> = new Map<string, RouteRule>(
  R(`
GET    /health                                       any
GET    /public-config                                any
GET    /docs                                         any
GET    /docs/api-tokens.md                           any
GET    /docs/openapi.json                            any
GET    /docs/mcp.md                                  any
GET    /docs/skill.md                                any
POST   /auth/login                                   any
POST   /auth/mfa/totp                                any
POST   /auth/mfa/passkey/options                     any
POST   /auth/mfa/passkey/verify                      any
POST   /auth/logout                                  session
GET    /auth/me                                      any
GET    /account/quota                                any
PATCH  /account                                      session
POST   /account/password                             session
POST   /account/totp/setup                           session
POST   /account/totp/enable                          session
POST   /account/totp/disable                         session
POST   /account/passkeys/options                     session
POST   /account/passkeys/verify                      session
GET    /account/passkeys                             session
DELETE /account/passkeys/:id                         session
GET    /account/tokens                               session
POST   /account/tokens                               session
PATCH  /account/tokens/:id                           session
DELETE /account/tokens/:id                           session
GET    /account/tokens/scopes                        any

GET    /servers                                      servers:read
POST   /servers                                      servers:create
POST   /servers/import                               servers:create
GET    /servers/:id                                  servers:read
PATCH  /servers/:id                                  servers:configure
DELETE /servers/:id                                  servers:delete
POST   /servers/:id/power                            servers:power
POST   /servers/:id/command                          console:execute
GET    /servers/:id/logs                             logs:read
GET    /servers/:id/stats                            servers:read
GET    /servers/:id/players                          players:read
POST   /servers/:id/players/:name/:action            players:manage
GET    /servers/:id/join-attempts                    players:read
DELETE /servers/:id/join-attempts/:name              players:manage
GET    /servers/:id/lists/:kind                      players:read
GET    /servers/:id/properties                       servers:read
PUT    /servers/:id/properties                       servers:configure
POST   /servers/:id/clone                            servers:create
POST   /servers/:id/template                         templates:write
GET    /servers/:id/export                           files:read
GET    /servers/:id/icon                             servers:read
PUT    /servers/:id/icon                             servers:configure
DELETE /servers/:id/icon                             servers:configure

GET    /servers/:id/files                            files:read
GET    /servers/:id/files/content                    files:read
GET    /servers/:id/files/download                   files:read
PUT    /servers/:id/files/content                    files:write
POST   /servers/:id/files/upload                     files:write
POST   /servers/:id/files/mkdir                      files:write
POST   /servers/:id/files/rename                     files:write
DELETE /servers/:id/files                            files:write

GET    /servers/:id/backups                          backups:read
GET    /servers/:id/backups/:bid/download            backups:read
POST   /servers/:id/backups                          backups:write
DELETE /servers/:id/backups/:bid                     backups:write
POST   /servers/:id/backups/:bid/restore             backups:restore

GET    /servers/:id/mods                             mods:read
GET    /servers/:id/mods/updates                     mods:read
POST   /servers/:id/mods/install                     mods:write
PATCH  /servers/:id/mods/:file                       mods:write
DELETE /servers/:id/mods/:file                       mods:write

GET    /servers/:id/schedules                        schedules:read
POST   /servers/:id/schedules                        schedules:write
PATCH  /schedules/:id                                schedules:write
DELETE /schedules/:id                                schedules:write
POST   /schedules/:id/run                            schedules:write

GET    /webhooks/events                              webhooks:read
GET    /webhooks                                     webhooks:read
POST   /webhooks                                     webhooks:write
GET    /servers/:id/webhooks                         webhooks:read
POST   /servers/:id/webhooks                         webhooks:write
PATCH  /webhooks/:id                                 webhooks:write
DELETE /webhooks/:id                                 webhooks:write
POST   /webhooks/:id/test                            webhooks:write

GET    /servers/:id/shares                           shares:read
POST   /servers/:id/shares                           shares:write
DELETE /servers/:id/shares/:userId                   shares:write
GET    /users/lookup                                 shares:read

GET    /templates                                    templates:read
POST   /templates                                    templates:write
POST   /templates/:id/instantiate                    servers:create
DELETE /templates/:id                                templates:write

GET    /games                                        games:read
GET    /games/:id                                    games:read
POST   /games/validate                               games:read
POST   /games                                        games:write
PUT    /games/:id                                    games:write
DELETE /games/:id                                    games:write
GET    /catalog/search                               games:read
GET    /catalog/project/:source/:id                  games:read
GET    /catalog/project/:source/:id/versions         games:read
GET    /catalog/minecraft/versions                   games:read
GET    /catalog/minecraft/loaders                    games:read
GET    /workshop/search                              games:read
GET    /workshop/items/:id                           games:read

POST   /servers/:id/steam/update                     servers:configure
POST   /servers/:id/steam/regenerate                 servers:configure
GET    /servers/:id/workshop                         mods:read
POST   /servers/:id/workshop                         mods:write
DELETE /servers/:id/workshop/:itemId                 mods:write
POST   /servers/:id/workshop/refresh                 mods:write

GET    /servers/:id/terraria/worlds                  servers:read
POST   /servers/:id/terraria/world                   servers:configure

GET    /servers/:id/l4d2/maps                        servers:read
GET    /servers/:id/l4d2/controls                    servers:read
POST   /servers/:id/l4d2/controls/map                console:execute
POST   /servers/:id/l4d2/controls/difficulty         console:execute
POST   /servers/:id/l4d2/controls/kick               console:execute
POST   /servers/:id/l4d2/controls/give               console:execute
POST   /servers/:id/l4d2/controls/bots                console:execute
POST   /servers/:id/l4d2/controls/team                console:execute
GET    /servers/:id/l4d2/plugins                     mods:read
POST   /servers/:id/l4d2/plugins/:pluginId/install   mods:write
DELETE /servers/:id/l4d2/plugins/:pluginId           mods:write
PUT    /servers/:id/l4d2/plugins/:pluginId/settings  mods:write

GET    /servers/:id/bluemap                          servers:read
PUT    /servers/:id/bluemap                          servers:configure
POST   /servers/:id/bluemap/reset                    servers:configure
GET    /servers/:id/bluemap/links                    servers:read
POST   /servers/:id/bluemap/links                    servers:configure
PATCH  /servers/:id/bluemap/links/:linkId            servers:configure
DELETE /servers/:id/bluemap/links/:linkId            servers:configure
GET    /servers/:id/bluemap/marker-sets              servers:read
POST   /servers/:id/bluemap/marker-sets              servers:configure
PATCH  /servers/:id/bluemap/marker-sets/:setId       servers:configure
DELETE /servers/:id/bluemap/marker-sets/:setId       servers:configure
GET    /servers/:id/bluemap/markers                  servers:read
POST   /servers/:id/bluemap/markers                  servers:configure
PATCH  /servers/:id/bluemap/markers/:markerId        servers:configure
DELETE /servers/:id/bluemap/markers/:markerId        servers:configure

GET    /users                                        admin:read
POST   /users                                        admin:write
PATCH  /users/:id                                    admin:write
DELETE /users/:id                                    admin:write
GET    /users/:id/games                              admin:read
PUT    /users/:id/games                              admin:write
GET    /admin/settings                               admin:read
PUT    /admin/settings                               admin:write
GET    /admin/ports                                  admin:read
GET    /admin/system                                 admin:read
GET    /admin/processes                              admin:read
GET    /admin/audit                                  admin:read
GET    /admin/games                                  admin:read
PUT    /admin/games/:key/disabled                    admin:write
GET    /admin/update                                 admin:read
GET    /admin/update/log                             admin:read
POST   /admin/update/check                           admin:update
POST   /admin/update/apply                           admin:update
POST   /admin/update/rollback                        admin:update

POST   /internal/stop-all                            session
GET    /ws                                           any
POST   /mcp                                          any
GET    /mcp                                          any
DELETE /mcp                                          any
`),
);

/** Methods the generic web-UI proxy answers; they are never available to keys. */
const SESSION_ONLY_PREFIXES = ['/servers/:id/webui/'];

/** Rule for a route (`pattern` is the Fastify route URL without the `/api` prefix). */
export function ruleFor(method: string, pattern: string): RouteRule | null {
  const hit = ROUTE_RULES.get(`${method.toUpperCase()} ${pattern}`);
  if (hit) return hit;
  if (SESSION_ONLY_PREFIXES.some((p) => pattern.startsWith(p))) return 'session';
  return null;
}

/** Resolves the server a route works on: the `:id` of `/servers/:id/...`, when there is one. */
export function serverIdOf(pattern: string, params: Record<string, unknown> | undefined): string | null {
  if (pattern === '/servers/:id' || pattern.startsWith('/servers/:id/')) {
    const id = params?.id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

export type Decision =
  | { ok: true }
  | { ok: false; status: 401 | 403; code: string; message: string; required?: string };

export interface KeyLimits {
  scopes: readonly string[];
  /** null: every server the owner can reach. */
  serverIds: readonly string[] | null;
}

/** Pure: may a key with these limits call this route? (`resolvedServer` is the server of `/schedules/:id` and `/webhooks/:id`.) */
export function authorizeKey(limits: KeyLimits, method: string, pattern: string, params: Record<string, unknown> | undefined, resolvedServer?: string | null): Decision {
  if (!limits.scopes.includes('*')) {
    const rule = ruleFor(method, pattern);
    if (rule === null) return { ok: false, status: 403, code: 'scope_not_mapped', message: 'This endpoint is not available to API keys with limited scopes' };
    if (rule === 'session') return { ok: false, status: 403, code: 'session_required', message: 'This action requires an interactive session' };
    if (rule !== 'any' && !grants(limits.scopes, rule)) {
      return { ok: false, status: 403, code: 'insufficient_scope', message: `This API key lacks the "${rule}" scope`, required: rule };
    }
  }
  return checkServer(limits, pattern, params, resolvedServer);
}

/** Server restriction: routes of one server need it in the list; routes that span servers are refused. */
function checkServer(limits: KeyLimits, pattern: string, params: Record<string, unknown> | undefined, resolved: string | null | undefined): Decision {
  if (!limits.serverIds) return { ok: true };
  const sid = serverIdOf(pattern, params) ?? resolved ?? null;
  if (sid) {
    return limits.serverIds.includes(sid) ? { ok: true } : { ok: false, status: 403, code: 'server_not_allowed', message: 'This API key is not allowed to use this server' };
  }
  if (pattern.startsWith('/schedules/') || pattern.startsWith('/webhooks/')) {
    return { ok: false, status: 403, code: 'server_not_allowed', message: 'This API key is not allowed to use this resource' };
  }
  if (pattern === '/webhooks' || pattern === '/users' || pattern.startsWith('/users/') || pattern.startsWith('/admin/')) {
    return { ok: false, status: 403, code: 'server_restricted', message: 'This endpoint is not available to API keys limited to some servers' };
  }
  return { ok: true };
}
