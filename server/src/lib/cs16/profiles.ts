import { badRequest } from '../errors.js';

/**
 * Config profiles of a Counter-Strike 1.6 server: named blocks of console commands (like a `.cfg` file) that the panel
 * sends to the game console one line after the other, on demand or automatically when the server starts.
 */

export const PROFILE_NAME_MAX = 60;
export const PROFILE_CONTENT_MAX = 64 * 1024;
export const PROFILE_COMMANDS_MAX = 1000;
export const PROFILE_LINE_MAX = 500;
export const PROFILES_MAX = 50;

export interface ProfileRecord {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfilesState {
  schema: 1;
  profiles: ProfileRecord[];
  defaultId: string | null;
  /** Also apply the default profile after every map change, not only once after the server starts. */
  applyOnMapChange: boolean;
}

export const emptyProfiles = (): ProfilesState => ({ schema: 1, profiles: [], defaultId: null, applyOnMapChange: false });

export function assertProfileName(v: unknown): string {
  if (typeof v !== 'string') throw badRequest('The profile needs a name', 'invalid_name');
  // eslint-disable-next-line no-control-regex
  const name = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name || name.length > PROFILE_NAME_MAX) throw badRequest(`The name must have 1 to ${PROFILE_NAME_MAX} characters`, 'invalid_name');
  return name;
}

/** Remove a `// comment` from a line, unless the `//` is inside double quotes (`hostname "a // b"`). */
export function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

export interface ParsedProfile {
  /** Commands in order, trimmed. */
  commands: string[];
  /** Blank and comment-only lines. */
  skipped: number;
}

/** Split a profile into the commands to send. */
export function parseProfile(content: string): ParsedProfile {
  const commands: string[] = [];
  let skipped = 0;
  for (const raw of content.split(/\r?\n/)) {
    const cmd = stripComment(raw).trim();
    if (cmd) commands.push(cmd);
    else skipped++;
  }
  return { commands, skipped };
}

export function assertProfileContent(v: unknown): string {
  if (typeof v !== 'string') throw badRequest('The profile needs its commands', 'invalid_content');
  if (v.length > PROFILE_CONTENT_MAX) throw badRequest(`The profile is too large (max ${PROFILE_CONTENT_MAX / 1024} KB)`, 'invalid_content');
  // Tabs and line breaks only: any other control character could end a console line early or confuse the game.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw badRequest('The profile contains characters that are not allowed', 'invalid_content');
  const { commands } = parseProfile(v);
  if (commands.length > PROFILE_COMMANDS_MAX) throw badRequest(`A profile can have at most ${PROFILE_COMMANDS_MAX} commands`, 'too_many_commands');
  const long = commands.findIndex((c) => c.length > PROFILE_LINE_MAX);
  if (long >= 0) throw badRequest(`A command is longer than ${PROFILE_LINE_MAX} characters`, 'line_too_long');
  return v.replace(/\r\n/g, '\n');
}
