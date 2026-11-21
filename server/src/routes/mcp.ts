import type { FastifyInstance, FastifyReply } from 'fastify';
import { APP_VERSION } from '../config.js';
import { handleMessage, type McpContext } from '../mcp/protocol.js';
import { loadSpec } from '../mcp/openapi.js';

/**
 * MCP server (v0.6.0): `POST /mcp` speaks the Model Context Protocol (Streamable HTTP, stateless). It needs an API key
 * (`Authorization: Bearer scf_...`); browser sessions are not accepted. Tools run through the REST API itself (an internal
 * request with the caller's own key), so scopes, server limits and every access check apply unchanged.
 */
export default async function mcpRoutes(app: FastifyInstance): Promise<void> {
  const unauthorized = (reply: FastifyReply) =>
    reply
      .code(401)
      .header('WWW-Authenticate', 'Bearer realm="ServCrafty"')
      .send({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'An API key is required: send "Authorization: Bearer scf_..." (create one in Account > API keys).' } });

  app.post('/mcp', async (req, reply) => {
    if (req.authVia !== 'token' || !req.apiKey) return unauthorized(reply);
    const key = req.apiKey;
    void loadSpec(); // warm the OpenAPI cache
    const ctx: McpContext = {
      limits: { scopes: key.scopes, serverIds: key.serverIds },
      version: APP_VERSION,
      callApi: async (method, url, body) => {
        const headers: Record<string, string> = { authorization: String(req.headers.authorization) };
        // The LAN-only rule looks at the client address and the Cloudflare headers: pass them on.
        for (const h of ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-real-ip', 'user-agent']) {
          const v = req.headers[h];
          if (typeof v === 'string') headers[h] = v;
        }
        const res = await app.inject({
          method: method as 'GET',
          url: `/api${url}`,
          headers: body === null ? headers : { ...headers, 'content-type': 'application/json' },
          ...(body === null ? {} : { payload: JSON.stringify(body) }),
          remoteAddress: req.ip,
        });
        return { status: res.statusCode, body: res.body };
      },
    };
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter((r) => r !== null);
      if (!out.length) return reply.code(202).send();
      return out;
    }
    const res = await handleMessage(body, ctx);
    if (res === null) return reply.code(202).send();
    return res;
  });

  // No server-initiated messages and no sessions to close.
  const notAllowed = async (_req: unknown, reply: FastifyReply) =>
    reply.code(405).header('Allow', 'POST').send({ error: { code: 'method_not_allowed', message: 'This MCP endpoint accepts POST only' } });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
