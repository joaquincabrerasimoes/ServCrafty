import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SERVER_ROOT } from '../config.js';
import { requireUser } from '../auth/plugin.js';
import { notFound } from '../lib/errors.js';
import { getPublicUrl } from '../services/settings.js';

/**
 * API documentation shipped with the server (`server/docs/`): a guide for humans and an OpenAPI 3.0 file.
 * Both contain a `{{BASE_URL}}` placeholder that is replaced at download time with the panel's public URL.
 */

interface DocFile {
  id: string;
  title: string;
  file: string;
  filename: string;
  contentType: string;
  url: string;
  /** Replacement for the `{{BASE_URL}}` placeholder, given the public URL (no trailing slash). */
  base: (publicUrl: string) => string;
}

export const DOC_FILES: DocFile[] = [
  {
    id: 'api-tokens',
    title: 'API token guide (Markdown)',
    file: 'api-tokens.md',
    filename: 'servcrafty-api-tokens.md',
    contentType: 'text/markdown; charset=utf-8',
    url: '/api/docs/api-tokens.md',
    base: (u) => u,
  },
  {
    id: 'openapi',
    title: 'OpenAPI 3 specification (JSON)',
    file: 'openapi.json',
    filename: 'servcrafty-openapi.json',
    contentType: 'application/json; charset=utf-8',
    url: '/api/docs/openapi.json',
    // The API lives under /api; the guide's own URLs already include it where needed.
    base: (u) => `${u}/api`,
  },
];

/** Directory with the shipped docs (overridable for tests via DOCS_DIR). */
export function docsDir(): string {
  return process.env.DOCS_DIR ? path.resolve(process.env.DOCS_DIR) : path.join(SERVER_ROOT, 'docs');
}

const cache = new Map<string, string>();

async function readDoc(file: string): Promise<string> {
  const hit = cache.get(file);
  if (hit !== undefined) return hit;
  let text: string;
  try {
    text = await fsp.readFile(path.join(docsDir(), file), 'utf8');
  } catch {
    throw notFound('Documentation file is not available on this installation', 'doc_not_found');
  }
  cache.set(file, text);
  return text;
}

/** Pure: replace every `{{BASE_URL}}` placeholder. */
export function renderDoc(text: string, base: string): string {
  return text.split('{{BASE_URL}}').join(base);
}

export default async function docsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/docs', async (req) => {
    requireUser(req);
    return DOC_FILES.map((d) => ({ id: d.id, title: d.title, filename: d.filename, url: d.url, contentType: d.contentType.split(';')[0] }));
  });

  for (const d of DOC_FILES) {
    app.get(`/docs/${d.file}`, async (req, reply) => {
      requireUser(req);
      const publicUrl = await getPublicUrl();
      const body = renderDoc(await readDoc(d.file), d.base(publicUrl));
      return reply
        .header('Content-Type', d.contentType)
        .header('Content-Disposition', `attachment; filename="${d.filename}"`)
        .header('Cache-Control', 'no-cache')
        .send(body);
    });
  }
}
