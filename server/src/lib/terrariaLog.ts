/**
 * Pure helpers to read Terraria server console output (all three variants).
 * The vanilla and TShock containers run with a TTY, so their output carries ANSI sequences,
 * carriage returns and the ": " input prompt in front of lines.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Strip ANSI escapes, control characters (keeps tabs) and leading console prompts. */
export function cleanTerrariaLine(raw: string): string {
  let line = raw.replace(ANSI, '').replace(CONTROL, '');
  // The console prompt (": ") is printed without a newline, so output that follows lands after it.
  line = line.replace(/^(?:\s*:\s)+/, '');
  return line.trimEnd();
}

export type TerrariaLogEvent =
  | { kind: 'join'; player: string }
  | { kind: 'leave'; player: string }
  | { kind: 'ready' }
  | { kind: 'version'; version: string };

const RE_PLAYER = /^([^<\[\s][^\r\n]{0,39}?)(?: \([0-9A-Fa-f.:[\]]{3,64}\))? has (joined|left)\.$/;
const RE_READY = /^Server started$|^Server started\b|^Listening on port \d+/;
const RE_VERSION = /\bTerraria Server v(\d+\.\d+(?:\.\d+){0,2})\b/;

/** Interpret one cleaned console line. */
export function parseTerrariaLine(line: string): TerrariaLogEvent | null {
  const p = RE_PLAYER.exec(line);
  if (p?.[1]) {
    const player = p[1].trim();
    if (player) return { kind: p[2] === 'joined' ? 'join' : 'leave', player };
  }
  if (RE_READY.test(line)) return { kind: 'ready' };
  const v = RE_VERSION.exec(line);
  if (v?.[1]) return { kind: 'version', version: v[1] };
  return null;
}
