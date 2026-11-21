import fs from 'node:fs';
import path from 'node:path';
import { docsDir } from '../routes/docs.js';

/**
 * Reads the shipped OpenAPI file (server/docs/openapi.json) so the MCP tools describe their arguments exactly as the REST API
 * validates them, without a second copy of every schema.
 */

type Json = Record<string, unknown>;

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  parameters?: Array<Json>;
  requestBody?: { content?: Record<string, { schema?: Json }> };
}

interface Spec {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: Record<string, Record<string, unknown>>;
}

let cached: Spec | null | undefined;

export function loadSpec(): Spec | null {
  if (cached !== undefined) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(path.join(docsDir(), 'openapi.json'), 'utf8')) as Spec;
  } catch {
    cached = null;
  }
  return cached;
}

/** For tests: use another spec. */
export function setSpecForTests(spec: Spec | null | undefined): void {
  cached = spec;
}

function resolveRef(spec: Spec, ref: string): unknown {
  let cur: unknown = spec;
  for (const part of ref.replace(/^#\//, '').split('/')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Json)[part];
  }
  return cur;
}

/** Inlines `$ref`s (with a depth guard for recursive schemas) and turns OpenAPI 3.0 `nullable` into a JSON Schema type union. */
export function inline(spec: Spec, node: unknown, depth = 0): unknown {
  if (Array.isArray(node)) return node.map((n) => inline(spec, n, depth));
  if (!node || typeof node !== 'object') return node;
  const obj = node as Json;
  if (typeof obj.$ref === 'string') {
    if (depth > 6) return {};
    return inline(spec, resolveRef(spec, obj.$ref), depth + 1);
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'example' || k === 'examples' || k === 'xml' || k === 'externalDocs') continue;
    out[k] = inline(spec, v, depth);
  }
  if (out.nullable === true) {
    delete out.nullable;
    if (typeof out.type === 'string') out.type = [out.type, 'null'];
  } else {
    delete out.nullable;
  }
  return out;
}

export interface ParamInfo {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: unknown;
  description?: string;
}

/** OpenAPI path template of a Fastify-style route (`/servers/:id` -> `/servers/{id}`). */
export const toTemplate = (pattern: string) => pattern.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

export function operationOf(method: string, template: string): OpenApiOperation | null {
  return loadSpec()?.paths[template]?.[method.toLowerCase()] ?? null;
}

export function paramsOf(method: string, template: string): ParamInfo[] {
  const spec = loadSpec();
  const op = operationOf(method, template);
  if (!spec || !op) return [];
  const out: ParamInfo[] = [];
  for (const raw of op.parameters ?? []) {
    const p = inline(spec, raw) as Json;
    if (p.in !== 'path' && p.in !== 'query') continue;
    out.push({ name: String(p.name), in: p.in, required: p.in === 'path' || p.required === true, schema: p.schema ?? { type: 'string' }, description: typeof p.description === 'string' ? p.description : undefined });
  }
  return out;
}

/** The JSON body schema of an operation, if any. */
export function bodySchemaOf(method: string, template: string): Json | null {
  const spec = loadSpec();
  const op = operationOf(method, template);
  const schema = op?.requestBody?.content?.['application/json']?.schema;
  if (!spec || !schema) return null;
  return inline(spec, schema) as Json;
}

/**
 * Input schema of a tool: path and query parameters plus the properties of the JSON body, flattened into one object (the
 * names are split back when the tool runs).
 */
export function inputSchemaOf(method: string, template: string): Json {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of paramsOf(method, template)) {
    properties[p.name] = p.description && typeof p.schema === 'object' && p.schema ? { ...(p.schema as Json), description: p.description } : p.schema;
    if (p.required) required.push(p.name);
  }
  const body = bodySchemaOf(method, template);
  if (body && body.type === 'object' && body.properties && typeof body.properties === 'object') {
    Object.assign(properties, body.properties as Json);
    for (const r of (body.required as string[] | undefined) ?? []) if (!required.includes(r)) required.push(r);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

export interface EndpointSummary {
  method: string;
  path: string;
  summary: string;
}

/** Every documented operation (for the `list_api_endpoints` tool). */
export function allOperations(): EndpointSummary[] {
  const spec = loadSpec();
  if (!spec) return [];
  const out: EndpointSummary[] = [];
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(ops)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) continue;
      out.push({ method: m.toUpperCase(), path: p, summary: op.summary ?? '' });
    }
  }
  return out;
}
