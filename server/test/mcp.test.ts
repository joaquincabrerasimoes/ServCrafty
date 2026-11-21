import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ??= 'postgres://servcrafty:servcrafty@127.0.0.1:1/servcrafty_mcp_test';
process.env.SECRET_KEY ??= 'x'.repeat(48);
process.env.LOG_LEVEL = 'silent';
process.env.WEB_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'does-not-exist');

const { handleMessage } = await import('../src/mcp/protocol.js');
const { TOOLS, GENERIC_TOOLS, toolAllowed, scopeOfTool, buildRequest, toolByName, apiRequestPathProblem, listEndpoints } = await import('../src/mcp/tools.js');
const { operationOf, inputSchemaOf } = await import('../src/mcp/openapi.js');
const { ruleFor } = await import('../src/lib/apiScopes.js');
const { buildApp } = await import('../src/app.js');

type Call = { method: string; url: string; body: unknown };

function ctx(scopes: string[], serverIds: string[] | null = null, answer: { status: number; body: string } = { status: 200, body: '{"ok":true}' }) {
  const calls: Call[] = [];
  return {
    calls,
    ctx: {
      limits: { scopes, serverIds },
      version: '9.9.9',
      callApi: async (method: string, url: string, body: unknown) => {
        calls.push({ method, url, body });
        return answer;
      },
    },
  };
}

const rpc = (method: string, params?: unknown, id = 1) => ({ jsonrpc: '2.0' as const, id, method, ...(params ? { params } : {}) });
const notification = (method: string) => ({ jsonrpc: '2.0' as const, method });

test('every tool maps to a documented operation and a scope rule', () => {
  const names = new Set<string>();
  for (const t of TOOLS) {
    assert.ok(!names.has(t.name), `duplicate tool ${t.name}`);
    names.add(t.name);
    assert.ok(operationOf(t.method, t.path), `${t.name}: ${t.method} ${t.path} is not in openapi.json`);
    const rule = ruleFor(t.method, t.path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1'));
    assert.ok(rule && rule !== 'session', `${t.name}: no usable scope rule (${rule})`);
    assert.ok(scopeOfTool(t));
    const schema = inputSchemaOf(t.method, t.path) as { type: string; properties: Record<string, unknown> };
    assert.equal(schema.type, 'object');
    // path parameters must be part of the input
    for (const m of t.path.matchAll(/\{([A-Za-z0-9_]+)\}/g)) assert.ok(m[1]! in schema.properties, `${t.name}: missing path parameter ${m[1]}`);
  }
  for (const g of GENERIC_TOOLS) assert.ok(!names.has(g.name));
});

test('initialize negotiates the protocol and describes the key', async () => {
  const { ctx: c } = ctx(['servers:read', 'logs:read'], ['a', 'b']);
  const r = (await handleMessage(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }), c)) as { result: { protocolVersion: string; serverInfo: { version: string }; instructions: string; capabilities: { tools: unknown } } };
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.equal(r.result.serverInfo.version, '9.9.9');
  assert.ok(r.result.capabilities.tools);
  assert.match(r.result.instructions, /logs:read/);
  assert.match(r.result.instructions, /limited to 2 server/);
  const unknown = (await handleMessage(rpc('initialize', { protocolVersion: '1999-01-01' }), c)) as { result: { protocolVersion: string } };
  assert.equal(unknown.result.protocolVersion, '2025-06-18');
});

test('notifications get no answer, unknown methods an error, ping works', async () => {
  const { ctx: c } = ctx(['*']);
  assert.equal(await handleMessage(notification('notifications/initialized'), c), null);
  assert.equal(await handleMessage(notification('whatever/else'), c), null);
  assert.deepEqual(await handleMessage(rpc('ping'), c), { jsonrpc: '2.0', id: 1, result: {} });
  const e = (await handleMessage(rpc('resources/list'), c)) as { error: { code: number } };
  assert.equal(e.error.code, -32601);
  const bad = (await handleMessage({ nope: true }, c)) as { error: { code: number } };
  assert.equal(bad.error.code, -32600);
});

test('tools/list only shows what the key can use', async () => {
  const list = async (scopes: string[]) => {
    const r = (await handleMessage(rpc('tools/list'), ctx(scopes).ctx)) as { result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> } };
    return r.result.tools.map((t) => t.name);
  };
  const ro = await list(['servers:read', 'logs:read']);
  assert.ok(ro.includes('list_servers') && ro.includes('get_logs'));
  assert.ok(!ro.includes('server_power') && !ro.includes('delete_server') && !ro.includes('send_command') && !ro.includes('write_file'));
  assert.ok(ro.includes('api_request') && ro.includes('list_api_endpoints') && ro.includes('whoami'));
  const full = await list(['*']);
  for (const t of TOOLS) assert.ok(full.includes(t.name), `${t.name} missing for a full key`);
  const power = await list(['servers:power']);
  assert.ok(power.includes('server_power') && !power.includes('list_servers'));
  // write implies read
  assert.ok((await list(['files:write'])).includes('list_files'));
  for (const t of TOOLS) assert.equal(toolAllowed({ scopes: ['*'], serverIds: null }, t), true);
});

test('tool arguments are split into path, query and body', () => {
  const power = buildRequest(toolByName('server_power')!, { id: 'abc', action: 'start' });
  assert.deepEqual(power, { url: '/servers/abc/power', body: { action: 'start' } });
  const logs = buildRequest(toolByName('get_logs')!, { id: 'abc', tail: 50 });
  assert.deepEqual(logs, { url: '/servers/abc/logs?tail=50', body: null });
  const action = buildRequest(toolByName('player_action')!, { id: 'abc', name: 'a b/c', action: 'kick' });
  assert.equal(action.url, '/servers/abc/players/a%20b%2Fc/kick');
  assert.throws(() => buildRequest(toolByName('server_power')!, { action: 'start' }), /Missing required argument "id"/);
  const del = buildRequest(toolByName('delete_server')!, { id: 'abc' });
  assert.deepEqual(del, { url: '/servers/abc', body: null });
});

test('tools/call runs the API request and formats the answer', async () => {
  const { ctx: c, calls } = ctx(['*'], null, { status: 200, body: '{"ok":true,"status":"starting"}' });
  const r = (await handleMessage(rpc('tools/call', { name: 'server_power', arguments: { id: 'abc', action: 'start' } }), c)) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.deepEqual(calls, [{ method: 'POST', url: '/servers/abc/power', body: { action: 'start' } }]);
  assert.equal(r.result.isError, false);
  assert.match(r.result.content[0]!.text, /"status": "starting"/);
});

test('API errors come back as tool errors with a hint for scope problems', async () => {
  const { ctx: c } = ctx(['servers:read'], null, { status: 403, body: JSON.stringify({ error: { code: 'insufficient_scope', message: 'This API key lacks the "servers:power" scope' } }) });
  const r = (await handleMessage(rpc('tools/call', { name: 'server_power', arguments: { id: 'abc', action: 'start' } }), c)) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0]!.text, /HTTP 403/);
  assert.match(r.result.content[0]!.text, /Ask the owner/);
});

test('unknown tools are a protocol error; long results are cut', async () => {
  const { ctx: c } = ctx(['*']);
  const e = (await handleMessage(rpc('tools/call', { name: 'format_disk', arguments: {} }), c)) as { error: { code: number } };
  assert.equal(e.error.code, -32602);
  const { ctx: big } = ctx(['*'], null, { status: 200, body: JSON.stringify({ lines: 'x'.repeat(200_000) }) });
  const r = (await handleMessage(rpc('tools/call', { name: 'get_logs', arguments: { id: 'a' } }), big)) as { result: { content: Array<{ text: string }> } };
  assert.ok(r.result.content[0]!.text.length < 61_000);
  assert.match(r.result.content[0]!.text, /truncated/);
});

test('api_request: paths are checked, bodies only on writes', async () => {
  assert.equal(apiRequestPathProblem('/servers'), null);
  assert.equal(apiRequestPathProblem('/servers/abc/l4d2/maps?x=1'), null);
  for (const bad of ['servers', '//evil.example/x', '/servers/../admin', '/auth/login', '/account/tokens', '/internal/stop-all', '/servers/a/webui/x', '/servers/a b']) {
    assert.notEqual(apiRequestPathProblem(bad), null, bad);
  }
  const { ctx: c, calls } = ctx(['*']);
  await handleMessage(rpc('tools/call', { name: 'api_request', arguments: { method: 'post', path: '/servers/abc/l4d2/controls/map', body: { map: 'c1m1_hotel' } } }), c);
  await handleMessage(rpc('tools/call', { name: 'api_request', arguments: { method: 'GET', path: '/servers/abc/l4d2/maps' } }), c);
  const refused = (await handleMessage(rpc('tools/call', { name: 'api_request', arguments: { method: 'GET', path: '/account/tokens' } }), c)) as { result: { isError: boolean } };
  assert.equal(refused.result.isError, true);
  assert.deepEqual(calls, [
    { method: 'POST', url: '/servers/abc/l4d2/controls/map', body: { map: 'c1m1_hotel' } },
    { method: 'GET', url: '/servers/abc/l4d2/maps', body: null },
  ]);
});

test('list_api_endpoints is limited to the key', () => {
  const ro = listEndpoints({ scopes: ['servers:read'], serverIds: null });
  assert.ok(ro.some((e) => e.method === 'GET' && e.path === '/servers'));
  assert.ok(!ro.some((e) => e.method === 'POST' && e.path === '/servers/{id}/power'));
  assert.ok(!ro.some((e) => e.path.startsWith('/account') || e.path.startsWith('/auth')));
  assert.ok(listEndpoints({ scopes: ['*'], serverIds: null }, 'power').some((e) => e.path === '/servers/{id}/power'));
});

test('POST /mcp needs an API key; GET and DELETE are not allowed', async () => {
  const app = await buildApp();
  await app.ready();
  try {
    const noKey = await app.inject({ method: 'POST', url: '/mcp', payload: rpc('ping') });
    assert.equal(noKey.statusCode, 401);
    assert.match(String(noKey.headers['www-authenticate']), /Bearer/);
    const get = await app.inject({ method: 'GET', url: '/mcp' });
    assert.equal(get.statusCode, 405);
    assert.equal((await app.inject({ method: 'DELETE', url: '/mcp' })).statusCode, 405);
  } finally {
    await app.close();
  }
});

test('the MCP guide lists every tool; the skill only mentions real tools', async () => {
  const fs = await import('node:fs');
  const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs');
  const guide = fs.readFileSync(path.join(docs, 'mcp.md'), 'utf8');
  const skill = fs.readFileSync(path.join(docs, 'skill.md'), 'utf8');
  for (const t of [...TOOLS.map((x) => x.name), ...GENERIC_TOOLS.map((x) => x.name)]) assert.ok(guide.includes(`\`${t}\``), `mcp.md should list ${t}`);
  assert.match(skill, /^---\nname: servcrafty\ndescription: .+\n---\n/);
  const known = new Set([...TOOLS.map((x) => x.name), ...GENERIC_TOOLS.map((x) => x.name)]);
  const mentioned = [...skill.matchAll(/`([a-z]+(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]!).filter((n) => !['server_id'].includes(n));
  const unknown = mentioned.filter((n) => !known.has(n) && !/^(insufficient_|server_not_|session_|scope_|game_|quota_|no_free|validation_|invalid_|insufficient)/.test(n) && !['restart_required', 'rolled_back'].includes(n));
  assert.deepEqual(unknown, [], `skill.md mentions tools that do not exist: ${unknown.join(', ')}`);
  for (const text of [guide, skill]) for (const m of text.matchAll(/scf_[A-Za-z0-9_-]{8,}/g)) assert.match(m[0], /^scf_x+$/);
});
