import { expandScopes, type KeyLimits } from '../lib/apiScopes.js';
import { apiRequestPathProblem, ArgError, buildRequest, describeTool, GENERIC_TOOLS, listEndpoints, toolAllowed, toolByName, TOOLS } from './tools.js';

/**
 * Model Context Protocol over Streamable HTTP, stateless (every POST is independent; no sessions, no server-initiated
 * messages). Implements what an agent needs: initialize, ping, tools/list and tools/call.
 */

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const MAX_RESULT_CHARS = 24_000;

export interface ApiResult {
  status: number;
  body: string;
}

export interface McpContext {
  limits: KeyLimits;
  version: string;
  /** Runs an API request as the caller (path relative to /api). */
  callApi: (method: string, url: string, body: unknown) => Promise<ApiResult>;
}

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export type RpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } };

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

const err = (id: RpcRequest['id'], code: number, message: string, data?: unknown): RpcResponse => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});
const ok = (id: RpcRequest['id'], result: unknown): RpcResponse => ({ jsonrpc: '2.0', id: id ?? null, result });

export function instructions(limits: KeyLimits): string {
  const granted = limits.scopes.includes('*') ? 'everything its owner can do' : expandScopes(limits.scopes).join(', ');
  return [
    'ServCrafty is a self-hosted game-server panel (Minecraft, Terraria and SteamCMD games such as Left 4 Dead 2). Each game server runs in its own Docker container.',
    `This API key may: ${granted}.${limits.serverIds ? ` It is limited to ${limits.serverIds.length} server(s); servers it creates are added to its list.` : ''}`,
    'Typical flow: list_games -> create_server -> server_power {action:"start"} -> server_stats until running -> get_logs. Start/restart return before the server is up; poll server_stats.',
    'Server ids are UUIDs from list_servers. Destructive tools (delete_server, delete_file, restore_backup, ...) cannot be undone: confirm with the user first.',
    'Use list_api_endpoints and api_request for anything without a dedicated tool.',
  ].join('\n');
}

function textResult(text: string, isError = false, keep: 'head' | 'tail' = 'head'): ToolResult {
  let t = text;
  if (text.length > MAX_RESULT_CHARS) {
    const cut = text.length - MAX_RESULT_CHARS;
    // Logs are read from the end (the newest lines matter), everything else from the start.
    t = keep === 'tail' ? `... (${cut} earlier characters left out; ask for a smaller tail or a later offset)\n${text.slice(cut)}` : `${text.slice(0, MAX_RESULT_CHARS)}\n... (truncated, ${cut} more characters; ask for less, e.g. a smaller tail)`;
  }
  return { content: [{ type: 'text', text: t }], isError };
}

/** Formats an API answer for the model; errors carry the code so the agent can react (insufficient_scope, quota_exceeded, ...). */
export function formatApi(r: ApiResult, keep: 'head' | 'tail' = 'head'): ToolResult {
  let pretty = r.body;
  try {
    pretty = JSON.stringify(JSON.parse(r.body), null, 2);
  } catch {
    /* not JSON: keep as is */
  }
  if (r.status >= 400) {
    let hint = '';
    try {
      const j = JSON.parse(r.body) as { error?: { code?: string } };
      if (j.error?.code === 'insufficient_scope') hint = '\nThis API key does not have the needed scope. Ask the owner to grant it in Account > API keys.';
      if (j.error?.code === 'server_not_allowed') hint = '\nThis API key is limited to specific servers and this is not one of them.';
    } catch {
      /* ignore */
    }
    return textResult(`HTTP ${r.status}\n${pretty}${hint}`, true);
  }
  return textResult(pretty || '(empty response)', false, keep);
}

async function callTool(name: string, args: Record<string, unknown>, ctx: McpContext): Promise<ToolResult | null> {
  if (name === 'list_api_endpoints') {
    return textResult(JSON.stringify(listEndpoints(ctx.limits, typeof args.search === 'string' ? args.search : undefined), null, 1));
  }
  if (name === 'api_request') {
    const method = String(args.method ?? '').toUpperCase();
    const p = String(args.path ?? '');
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return textResult('method must be GET, POST, PUT, PATCH or DELETE', true);
    const problem = apiRequestPathProblem(p);
    if (problem) return textResult(problem, true);
    return formatApi(await ctx.callApi(method, p, method === 'GET' || method === 'DELETE' ? null : (args.body ?? {})));
  }
  const tool = toolByName(name);
  if (!tool) return null;
  let req: ReturnType<typeof buildRequest>;
  try {
    req = buildRequest(tool, args);
  } catch (e) {
    if (e instanceof ArgError) return textResult(e.message, true);
    throw e;
  }
  return formatApi(await ctx.callApi(tool.method, req.url, req.body), tool.keepTail ? 'tail' : 'head');
}

/** Handles one JSON-RPC message; notifications (no id) answer null. */
export async function handleMessage(raw: unknown, ctx: McpContext): Promise<RpcResponse | null> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return err(null, -32600, 'Invalid Request');
  const msg = raw as Partial<RpcRequest>;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg.id, -32600, 'Invalid Request');
  const isNotification = msg.id === undefined;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  switch (msg.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = (SUPPORTED_PROTOCOLS as readonly string[]).includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
      return ok(msg.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'servcrafty', title: 'ServCrafty', version: ctx.version },
        instructions: instructions(ctx.limits),
      });
    }
    case 'ping':
      return isNotification ? null : ok(msg.id, {});
    case 'tools/list': {
      const tools = [...TOOLS.filter((t) => toolAllowed(ctx.limits, t)).map(describeTool), ...GENERIC_TOOLS];
      return ok(msg.id, { tools });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const result = await callTool(name, args, ctx);
      if (!result) return err(msg.id, -32602, `Unknown tool: ${name}`);
      return ok(msg.id, result);
    }
    default:
      if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...
      return err(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}
