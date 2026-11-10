import assert from 'node:assert/strict';
import diagnostics_channel from 'node:diagnostics_channel';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Build the real app without a database: routes only touch the DB when a request is handled.
process.env.DATABASE_URL ??= 'postgres://servcrafty:servcrafty@127.0.0.1:1/servcrafty_docs_test';
process.env.SECRET_KEY ??= 'x'.repeat(48);
process.env.LOG_LEVEL = 'silent';
process.env.WEB_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'does-not-exist');

const { buildApp } = await import('../src/app.js');
const { renderDoc, DOC_FILES } = await import('../src/routes/docs.js');

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs');
const spec = JSON.parse(fs.readFileSync(path.join(DOCS, 'openapi.json'), 'utf8')) as OpenApi;
const guide = fs.readFileSync(path.join(DOCS, 'api-tokens.md'), 'utf8');

interface Operation {
  tags?: string[];
  operationId?: string;
  summary?: string;
  parameters?: Array<{ $ref?: string; name?: string; in?: string }>;
  requestBody?: unknown;
  responses?: Record<string, unknown>;
}
interface OpenApi {
  openapi: string;
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  tags: Array<{ name: string }>;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown>; parameters: Record<string, unknown>; responses: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  security: unknown[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'];

/** Every route the real app registers, as "METHOD /path" (path relative to /api, `:id` written as `{id}`). */
async function registeredRoutes(): Promise<{ routes: Set<string>; close: () => Promise<void>; inject: (o: { method: 'GET'; url: string }) => Promise<{ statusCode: number; json: () => unknown }> }> {
  const routes = new Set<string>();
  const onInit = (msg: unknown) => {
    const { fastify } = msg as { fastify: { addHook: (n: string, f: (r: { method: string | string[]; url: string }) => void) => void } };
    fastify.addHook('onRoute', (r) => {
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
        if (m === 'HEAD' || m === 'OPTIONS') continue;
        routes.add(`${m} ${r.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`);
      }
    });
  };
  diagnostics_channel.subscribe('fastify.initialization', onInit);
  const app = await buildApp();
  diagnostics_channel.unsubscribe('fastify.initialization', onInit);
  await app.ready();
  return {
    routes,
    close: () => app.close(),
    inject: (o) => app.inject(o) as unknown as Promise<{ statusCode: number; json: () => unknown }>,
  };
}

function walk(node: unknown, visit: (n: unknown) => void): void {
  visit(node);
  if (Array.isArray(node)) node.forEach((c) => walk(c, visit));
  else if (node && typeof node === 'object') Object.values(node).forEach((c) => walk(c, visit));
}

function resolveRef(ref: string): unknown {
  assert.ok(ref.startsWith('#/'), `only local refs are allowed: ${ref}`);
  let cur: unknown = spec;
  for (const part of ref.slice(2).split('/')) {
    assert.ok(cur && typeof cur === 'object' && part in cur, `unresolved $ref ${ref}`);
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

test('openapi.json has the required OpenAPI 3 structure', () => {
  assert.equal(spec.openapi, '3.0.3');
  assert.ok(spec.info.title && spec.info.version);
  assert.deepEqual(spec.servers.map((s) => s.url), ['{{BASE_URL}}']);
  assert.ok(spec.paths && Object.keys(spec.paths).length > 50);
  assert.ok(spec.components.schemas.Error, 'Error schema');
  assert.ok(spec.components.securitySchemes.bearerAuth, 'bearerAuth scheme');
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
  const tagNames = new Set(spec.tags.map((t) => t.name));
  const ids = new Set<string>();
  for (const [p, item] of Object.entries(spec.paths)) {
    assert.ok(p.startsWith('/'), p);
    for (const [method, op] of Object.entries(item)) {
      assert.ok(METHODS.includes(method), `${p}: bad method ${method}`);
      const where = `${method.toUpperCase()} ${p}`;
      assert.ok(op.tags?.length, `${where}: needs a tag`);
      for (const t of op.tags!) assert.ok(tagNames.has(t), `${where}: tag "${t}" is not declared in tags`);
      assert.ok(op.responses && Object.keys(op.responses).length > 0, `${where}: needs responses`);
      assert.ok(op.summary, `${where}: needs a summary`);
      assert.ok(op.operationId && !ids.has(op.operationId), `${where}: operationId missing or duplicated`);
      ids.add(op.operationId!);
      // Every {param} of the path must be declared as a path parameter.
      const declared = new Set((op.parameters ?? []).map((prm) => (prm.$ref ? (resolveRef(prm.$ref) as { name: string; in: string }) : (prm as { name: string; in: string }))).filter((prm) => prm.in === 'path').map((prm) => prm.name));
      for (const m of p.matchAll(/\{([^}]+)\}/g)) assert.ok(declared.has(m[1]!), `${where}: path parameter {${m[1]}} is not declared`);
    }
  }
});

test('every $ref in openapi.json resolves', () => {
  let n = 0;
  walk(spec, (node) => {
    if (node && typeof node === 'object' && '$ref' in node && typeof (node as { $ref: unknown }).$ref === 'string') {
      resolveRef((node as { $ref: string }).$ref);
      n++;
    }
  });
  assert.ok(n > 100, `expected many $refs, found ${n}`);
});

test('every documented method+path is a registered route (docs cannot drift)', async () => {
  const app = await registeredRoutes();
  try {
    const registered = [...app.routes].filter((r) => r.split(' ')[1]!.startsWith('/api/')).map((r) => {
      const [m, u] = r.split(' ');
      return `${m} ${u!.slice('/api'.length)}`;
    });
    const regSet = new Set(registered);

    const documented = new Set<string>();
    for (const [p, item] of Object.entries(spec.paths)) for (const m of Object.keys(item)) documented.add(`${m.toUpperCase()} ${p}`);

    const missing = [...documented].filter((d) => !regSet.has(d)).sort();
    assert.deepEqual(missing, [], `documented but not registered:\n  ${missing.join('\n  ')}`);

    // Informational: routes of the app that the spec does not describe (not a failure).
    const undocumented = registered.filter((r) => !documented.has(r)).sort();
    console.log(`[apiDocs] ${documented.size} documented operations; ${undocumented.length} registered routes are not documented:\n  ${undocumented.join('\n  ') || '(none)'}`);
  } finally {
    await app.close();
  }
});

test('the docs endpoints are protected and listed', async () => {
  const app = await registeredRoutes();
  try {
    assert.ok(app.routes.has('GET /api/docs'));
    assert.ok(app.routes.has('GET /api/docs/api-tokens.md'));
    assert.ok(app.routes.has('GET /api/docs/openapi.json'));
    for (const url of ['/api/docs', '/api/docs/api-tokens.md', '/api/docs/openapi.json']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 401, url);
      assert.equal((r.json() as { error: { code: string } }).error.code, 'unauthorized');
    }
  } finally {
    await app.close();
  }
});

test('docs index metadata matches the files on disk', () => {
  assert.deepEqual(DOC_FILES.map((d) => d.filename), ['servcrafty-api-tokens.md', 'servcrafty-openapi.json']);
  for (const d of DOC_FILES) assert.ok(fs.existsSync(path.join(DOCS, d.file)), d.file);
});

test('{{BASE_URL}} is replaced at download time', () => {
  assert.equal(renderDoc('a {{BASE_URL}}/x {{BASE_URL}}', 'https://p.example'), 'a https://p.example/x https://p.example');
  const openapi = DOC_FILES.find((d) => d.id === 'openapi')!;
  const out = JSON.parse(renderDoc(fs.readFileSync(path.join(DOCS, 'openapi.json'), 'utf8'), openapi.base('https://p.example'))) as OpenApi;
  assert.equal(out.servers[0]!.url, 'https://p.example/api');
  const md = renderDoc(guide, DOC_FILES.find((d) => d.id === 'api-tokens')!.base('https://p.example'));
  assert.ok(!md.includes('{{BASE_URL}}'));
  assert.ok(md.includes('BASE="https://p.example/api"'));
});

test('the guide only calls documented endpoints', () => {
  const templates = Object.keys(spec.paths).map((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`));
  // Paths written as "$BASE/..." in the curl recipes, plus the explicit mentions with backticks in the text.
  const seen = new Set<string>();
  for (const m of guide.matchAll(/\$BASE(\/[^\s"'?`]*)/g)) seen.add(m[1]!);
  assert.ok(seen.size > 30, `found only ${seen.size} endpoints in the guide`);
  const bad = [...seen].filter((p) => !templates.some((t) => t.test(p.replace(/\$[A-Za-z_]+|<[^>]+>/g, 'x'))));
  assert.deepEqual(bad, [], `the guide uses endpoints that openapi.json does not describe: ${bad.join(', ')}`);
});

test('examples never contain a real-looking token', () => {
  for (const [name, text] of [['guide', guide], ['openapi', JSON.stringify(spec)]] as const) {
    for (const m of text.matchAll(/scf_[A-Za-z0-9_-]{8,}/g)) {
      assert.match(m[0], /^scf_x+$/, `${name}: "${m[0]}" is not an obvious placeholder`);
    }
  }
});

test('the guide covers the required topics', () => {
  for (const needle of ['Authorization: Bearer', 'LAN', 'session_required', '{{BASE_URL}}', 'WebSocket', 'multipart', 'Troubleshooting', 'Python', 'fetch', 'STEAMCMD', 'workshop', 'schedules', 'backups']) {
    assert.ok(guide.toLowerCase().includes(needle.toLowerCase()), `guide should mention "${needle}"`);
  }
});
