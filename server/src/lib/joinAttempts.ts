/** Parsing of the Java server log lines that tell who tried to join without being whitelisted. */

export interface RejectedJoin {
  name: string;
  ip: string | null;
}

// "Disconnecting Stervil (/192.168.69.2:59834): You are not white-listed on this server!"
// Vanilla says "white-listed", Paper/Purpur say "whitelisted". The follow-up "lost connection" line is ignored
// on purpose so an attempt is counted once.
const RE_REJECTED = /Disconnecting (\w{1,16}) \(([^)]*)\): You are not white-?listed on this server/i;
// "UUID of player Stervil is b5d39a81-20ba-4414-bac7-81d989751cd1"
const RE_UUID = /UUID of player (\w{1,16}) is ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function parseRejectedJoin(line: string): RejectedJoin | null {
  const m = RE_REJECTED.exec(line);
  if (!m?.[1]) return null;
  // The address looks like "/192.168.69.2:59834" or "/[2001:db8::1]:59834"; keep the host only.
  const addr = (m[2] ?? '').replace(/^\//, '');
  const host = /^\[(.+)\]:\d+$/.exec(addr)?.[1] ?? /^(.+):\d+$/.exec(addr)?.[1] ?? addr;
  return { name: m[1], ip: host && host.length <= 64 ? host : null };
}

export function parseUuidLine(line: string): { name: string; uuid: string } | null {
  const m = RE_UUID.exec(line);
  return m?.[1] && m[2] ? { name: m[1], uuid: m[2].toLowerCase() } : null;
}
