/** Starting point for "New" in Admin > Games (fill in the Steam app id before saving). */
export const NEW_GAME_TEMPLATE = {
  schema: 1,
  id: 'my-game',
  name: 'My game',
  description: 'A dedicated server installed with SteamCMD.',
  icon: null,
  steam: { appId: 0, branch: null, betaPassword: null, platform: 'linux', login: 'anonymous' },
  resources: { memoryMb: 4096, memoryMinMb: 2048, cpu: 2, diskMb: 20480 },
  ports: [{ id: 'game', label: 'Game', protocol: 'udp', containerPort: 27015, mirror: false, publish: true, main: true }],
  variables: [
    { key: 'serverName', label: 'Server name', type: 'string', default: 'ServCrafty', required: true, group: 'Server' },
    { key: 'maxPlayers', label: 'Max players', type: 'number', default: 8, min: 1, max: 64, group: 'Server' },
    { key: 'password', label: 'Join password', type: 'password', default: '', group: 'Server' },
  ],
  launch: {
    cwd: '',
    command: ['./server', '-port={{ports.game}}', '-name={{serverName}}', '-maxplayers={{maxPlayers}}', { value: '-password={{password}}', if: 'password' }],
    env: {},
  },
  stop: { type: 'signal', signal: 'SIGINT', timeoutSec: 60 },
  console: { stdin: false },
};

export const toJson = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/** Code samples of the authoring reference (language-neutral, so not translated). */
export const REF_EXAMPLES = {
  template: `"-Port={{ports.game}}"   "{{server.name}}"   "{{workshop.ids}}"`,
  ports: `"ports": [
  { "id": "game",  "label": "Game",  "protocol": "both", "containerPort": 7777, "main": true },
  { "id": "query", "label": "Query", "protocol": "udp",  "containerPort": 27015, "mirror": true },
  { "id": "web",   "label": "Web admin", "protocol": "tcp", "containerPort": 8080, "publish": false }
]`,
  variables: `{ "key": "difficulty", "label": "Difficulty", "type": "select", "group": "Game",
  "options": [{ "value": "0", "label": "Normal" }, { "value": "1", "label": "Hard" }], "default": "0" }
{ "key": "pvp", "label": "PvP", "type": "boolean", "default": false, "valueMap": { "true": "1", "false": "0" } }`,
  launch: `"launch": { "cwd": "", "env": { "LD_LIBRARY_PATH": "./linux64" },
  "command": ["./Server.sh", "-port={{ports.game}}", { "value": "-password={{password}}", "if": "password" }] }`,
  composite: `{ "parts": [
    "{{map}}",
    "?MaxPlayers={{maxPlayers}}",
    { "value": "?GamePassword={{password}}", "if": "password" }
  ], "separator": "" }
// -> one argument such as  KF-BurningParis?MaxPlayers=6?GamePassword=secret`,
  generate: `{ "key": "adminPassword", "label": "Admin password", "type": "password",
  "generate": { "length": 16, "charset": "alnum" } }`,
  files: `"files": [
  { "type": "template", "path": "Config/server.cfg", "when": "missing", "content": "name={{serverName}}\\n" },
  { "type": "ini", "path": "Config/Game.ini", "when": "always",
    "set": [{ "section": "Engine.GameInfo", "key": "MaxPlayers", "value": "{{maxPlayers}}" }],
    "list": [{ "section": "OnlineSubsystemSteamworks.KFWorkshopSteamworks", "key": "ServerSubscribedWorkshopItems", "valuesFrom": "workshop" }] }
]`,
  lifecycle: `"stop": { "type": "stdin", "command": "quit", "timeoutSec": 60 },
"console": { "stdin": true },
"ready": { "logRegex": "Server is ready" }`,
  players: `"players": { "joinRegex": "Join succeeded: (?<name>.+)$", "leaveRegex": "(?<name>.+) left" },
"query": { "a2s": { "portId": "query" } }`,
  workshop: `"workshop": { "appId": 232090, "install": "steamcmd", "dir": "Mods" }`,
  webui: `"webui": [{ "id": "webadmin", "label": "Web admin", "portId": "web", "path": "/ServerAdmin/",
  "auth": { "type": "basic", "user": "{{adminUser}}", "password": "{{adminPassword}}" },
  "minAccess": "manager", "rewrite": true }]
// single-page admin UI that talks over WebSockets:
{ "id": "panel", "label": "Admin panel", "portId": "web", "path": "/", "websocket": true }`,
};

type PreviewVar = { key: string; type: string; valueMap?: Record<string, string>; generate?: unknown };
type PreviewDef = { ports?: unknown; variables?: unknown; launch?: unknown };

/**
 * Resolves `launch.command` with the values of the form preview, so authors can check conditional
 * and composite arguments. Mirrors the panel's rules: `{{key}}` after valueMap, `{{ports.<id>}}` =
 * container port, `if` = variable truthy (non-empty and not false/0). Returns null when the launch
 * block is not usable yet.
 */
export function previewArgv(def: PreviewDef, values: Record<string, string | boolean>): string[] | null {
  const launch = def.launch as { command?: unknown } | undefined;
  if (!launch || !Array.isArray(launch.command)) return null;
  const vars = (Array.isArray(def.variables) ? def.variables : []) as PreviewVar[];
  const ports = (Array.isArray(def.ports) ? def.ports : []) as Array<{ id?: string; containerPort?: number }>;
  const raw = (key: string): string => {
    const v = values[key];
    const meta = vars.find((x) => x && x.key === key);
    if ((v === '' || v === undefined) && meta?.generate) return '<generated>';
    return v === undefined ? '' : String(v);
  };
  const truthy = (key: unknown) => {
    if (typeof key !== 'string') return true;
    const v = raw(key);
    return v !== '' && v !== 'false' && v !== '0';
  };
  const render = (s: unknown) =>
    String(s ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, name: string) => {
      if (name.startsWith('ports.')) {
        const p = ports.find((x) => x && x.id === name.slice(6));
        return p?.containerPort !== undefined ? String(p.containerPort) : all;
      }
      if (name === 'server.name') return 'My server';
      if (name === 'server.id') return '<server-id>';
      if (name === 'workshop.ids') return '<workshop-ids>';
      const meta = vars.find((x) => x && x.key === name);
      if (!meta) return all;
      const v = raw(name);
      return meta.valueMap && v in meta.valueMap ? meta.valueMap[v]! : v;
    });
  const out: string[] = [];
  for (const el of launch.command as unknown[]) {
    if (typeof el === 'string') out.push(render(el));
    else if (el && typeof el === 'object') {
      const o = el as { value?: unknown; if?: unknown; parts?: unknown; separator?: unknown };
      if (!truthy(o.if)) continue;
      if (Array.isArray(o.parts)) {
        const parts = o.parts
          .filter((p) => typeof p === 'string' || (p && typeof p === 'object' && truthy((p as { if?: unknown }).if)))
          .map((p) => render(typeof p === 'string' ? p : (p as { value?: unknown }).value));
        out.push(parts.join(typeof o.separator === 'string' ? o.separator : ''));
      } else out.push(render(o.value));
    }
  }
  return out;
}

/** Line / column of a JSON.parse error, when the browser reports a position. */
export function jsonErrorLocation(text: string, err: unknown): { line: number; col: number } | null {
  const msg = err instanceof Error ? err.message : String(err);
  const lc = /line (\d+) column (\d+)/i.exec(msg);
  if (lc) return { line: Number(lc[1]), col: Number(lc[2]) };
  const pos = /position (\d+)/i.exec(msg);
  if (!pos) return null;
  const before = text.slice(0, Number(pos[1]));
  const lines = before.split('\n');
  return { line: lines.length, col: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

export function downloadJson(name: string, value: unknown) {
  const blob = new Blob([toJson(value)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
