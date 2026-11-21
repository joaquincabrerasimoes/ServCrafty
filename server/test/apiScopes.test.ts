import assert from 'node:assert/strict';
import diagnostics_channel from 'node:diagnostics_channel';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ??= 'postgres://servcrafty:servcrafty@127.0.0.1:1/servcrafty_scopes_test';
process.env.SECRET_KEY ??= 'x'.repeat(48);
process.env.LOG_LEVEL = 'silent';
process.env.WEB_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'does-not-exist');

const { SCOPES, SCOPE_IDS, PRESETS, ROUTE_RULES, ruleFor, grants, normalizeScopes, scopeProblem, expandScopes, authorizeKey } = await import('../src/lib/apiScopes.js');
const { buildApp } = await import('../src/app.js');

test('every route the app registers has a scope rule', async () => {
  const routes = new Set<string>();
  const onInit = (msg: unknown) => {
    const { fastify } = msg as { fastify: { addHook: (n: string, f: (r: { method: string | string[]; url: string }) => void) => void } };
    fastify.addHook('onRoute', (r) => {
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
        if (m === 'HEAD' || m === 'OPTIONS') continue;
        routes.add(`${m} ${r.url.startsWith('/api/') ? r.url.slice(4) : r.url}`);
      }
    });
  };
  diagnostics_channel.subscribe('fastify.initialization', onInit);
  const app = await buildApp();
  diagnostics_channel.unsubscribe('fastify.initialization', onInit);
  await app.ready();
  await app.close();
  const missing = [...routes].filter((r) => {
    const [method, ...rest] = r.split(' ');
    return ruleFor(method!, rest.join(' ')) === null;
  });
  assert.deepEqual(missing, [], `routes without a scope rule (add them to ROUTE_RULES in lib/apiScopes.ts): ${missing.join(', ')}`);
  // ... and the table has no stale entries.
  const stale = [...ROUTE_RULES.keys()].filter((k) => !routes.has(k));
  assert.deepEqual(stale, [], `scope rules for routes that do not exist: ${stale.join(', ')}`);
});

test('every rule is a known scope, any or session', () => {
  for (const [route, rule] of ROUTE_RULES) {
    assert.ok(rule === 'any' || rule === 'session' || SCOPE_IDS.includes(rule), `${route}: unknown rule ${rule}`);
  }
});

test('every scope is used by at least one route, and presets only use known scopes', () => {
  const used = new Set(ROUTE_RULES.values());
  for (const s of SCOPES) assert.ok(used.has(s.id), `scope ${s.id} protects no route`);
  for (const p of PRESETS) for (const s of p.scopes) assert.ok(s === '*' || SCOPE_IDS.includes(s), `preset ${p.id}: unknown scope ${s}`);
});

test('wildcards and write-implies-read', () => {
  assert.ok(grants(['*'], 'files:write'));
  assert.ok(grants(['files:*'], 'files:write'));
  assert.ok(grants(['files:write'], 'files:read'));
  assert.ok(!grants(['files:read'], 'files:write'));
  assert.ok(!grants(['files:write'], 'backups:read'));
  assert.ok(!grants(['servers:power'], 'servers:read')); // only read/write imply, other actions do not
  assert.deepEqual(normalizeScopes(['files:read', 'files:*', 'logs:read', 'files:read']), ['files:*', 'logs:read']);
  assert.deepEqual(normalizeScopes(['logs:read', '*']), ['*']);
  assert.ok(expandScopes(['files:write']).includes('files:read'));
});

test('scope validation by role', () => {
  assert.equal(scopeProblem(['servers:read', 'logs:read'], 'user'), null);
  assert.match(scopeProblem([], 'user') ?? '', /at least one/);
  assert.match(scopeProblem(['nope:read'], 'admin') ?? '', /Unknown/);
  assert.match(scopeProblem(['admin:write'], 'user') ?? '', /administrators/);
  assert.match(scopeProblem(['admin:*'], 'user') ?? '', /administrators/);
  assert.equal(scopeProblem(['admin:write'], 'admin'), null);
  assert.equal(scopeProblem(['*'], 'user'), null);
});

test('authorizeKey: scopes', () => {
  const ro = { scopes: ['servers:read', 'logs:read'], serverIds: null };
  assert.equal(authorizeKey(ro, 'GET', '/servers', {}).ok, true);
  assert.equal(authorizeKey(ro, 'GET', '/servers/:id/logs', { id: 'a' }).ok, true);
  const noPower = authorizeKey(ro, 'POST', '/servers/:id/power', { id: 'a' });
  assert.equal(noPower.ok, false);
  if (!noPower.ok) {
    assert.equal(noPower.code, 'insufficient_scope');
    assert.equal(noPower.required, 'servers:power');
  }
  // never with a key
  const s = authorizeKey({ scopes: ['admin:write', 'servers:read'], serverIds: null }, 'POST', '/account/password', {});
  assert.equal(s.ok, false);
  if (!s.ok) assert.equal(s.code, 'session_required');
  // unknown route: closed by default
  const u = authorizeKey(ro, 'GET', '/something/new', {});
  assert.equal(u.ok, false);
  if (!u.ok) assert.equal(u.code, 'scope_not_mapped');
  // the web UI proxy is session only
  assert.equal(authorizeKey(ro, 'GET', '/servers/:id/webui/:uiId/*', { id: 'a' }).ok, false);
  // full keys keep every route
  assert.equal(authorizeKey({ scopes: ['*'], serverIds: null }, 'DELETE', '/servers/:id', { id: 'a' }).ok, true);
  assert.equal(authorizeKey({ scopes: ['*'], serverIds: null }, 'GET', '/something/new', {}).ok, true);
});

test('authorizeKey: server list', () => {
  const key = { scopes: ['*'], serverIds: ['aaa'] };
  assert.equal(authorizeKey(key, 'GET', '/servers/:id', { id: 'aaa' }).ok, true);
  const other = authorizeKey(key, 'GET', '/servers/:id', { id: 'bbb' });
  assert.equal(other.ok, false);
  if (!other.ok) assert.equal(other.code, 'server_not_allowed');
  assert.equal(authorizeKey(key, 'GET', '/servers/:id/files', { id: 'bbb' }).ok, false);
  // creation, listing and catalogue stay available (the list itself is filtered by the route)
  assert.equal(authorizeKey(key, 'POST', '/servers', {}).ok, true);
  assert.equal(authorizeKey(key, 'GET', '/servers', {}).ok, true);
  assert.equal(authorizeKey(key, 'GET', '/games', {}).ok, true);
  // schedules and webhooks belong to a server
  assert.equal(authorizeKey(key, 'PATCH', '/schedules/:id', { id: 's' }, 'aaa').ok, true);
  assert.equal(authorizeKey(key, 'PATCH', '/schedules/:id', { id: 's' }, 'bbb').ok, false);
  assert.equal(authorizeKey(key, 'PATCH', '/schedules/:id', { id: 's' }, null).ok, false);
  assert.equal(authorizeKey(key, 'DELETE', '/webhooks/:id', { id: 'w' }, null).ok, false);
  // panel-wide administration is out of reach
  assert.equal(authorizeKey(key, 'GET', '/users', {}).ok, false);
  assert.equal(authorizeKey(key, 'GET', '/admin/settings', {}).ok, false);
  assert.equal(authorizeKey(key, 'GET', '/webhooks', {}).ok, false);
  // scopes and servers combine
  const both = { scopes: ['servers:read'], serverIds: ['aaa'] };
  assert.equal(authorizeKey(both, 'GET', '/servers/:id', { id: 'aaa' }).ok, true);
  assert.equal(authorizeKey(both, 'POST', '/servers/:id/power', { id: 'aaa' }).ok, false);
  assert.equal(authorizeKey(both, 'GET', '/servers/:id', { id: 'bbb' }).ok, false);
});

test('updating the panel has its own scope', () => {
  const reader = { scopes: ['admin:read'], serverIds: null };
  assert.equal(authorizeKey(reader, 'GET', '/admin/update', {}).ok, true);
  assert.equal(authorizeKey(reader, 'GET', '/admin/update/log', {}).ok, true);
  const denied = authorizeKey(reader, 'POST', '/admin/update/apply', {});
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.required, 'admin:update');
  const updater = { scopes: ['admin:read', 'admin:update'], serverIds: null };
  for (const p of ['/admin/update/check', '/admin/update/apply', '/admin/update/rollback']) assert.equal(authorizeKey(updater, 'POST', p, {}).ok, true, p);
  // updating does not include managing users or settings, and admin:write does not include updating
  assert.equal(authorizeKey(updater, 'POST', '/users', {}).ok, false);
  assert.equal(authorizeKey({ scopes: ['admin:write'], serverIds: null }, 'POST', '/admin/update/apply', {}).ok, false);
  assert.equal(authorizeKey({ scopes: ['admin:*'], serverIds: null }, 'POST', '/admin/update/apply', {}).ok, true);
  // a key limited to some servers never reaches panel administration
  assert.equal(authorizeKey({ scopes: ['*'], serverIds: ['a'] }, 'POST', '/admin/update/apply', {}).ok, false);
  // non-admins cannot hold it
  assert.match(scopeProblem(['admin:update'], 'user') ?? '', /administrators/);
});
