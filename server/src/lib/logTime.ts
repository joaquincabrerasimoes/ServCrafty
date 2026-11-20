/**
 * Timestamps of console lines. The panel asks Docker for log timestamps and keeps the one of every line
 * in the exact format of `docker logs -t` (RFC 3339 with nanoseconds, e.g. 2026-11-20T07:46:00.589825612Z).
 */

const STAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z) /;

/** Split the timestamp Docker put in front of a log line from the line itself. */
export function splitStamp(raw: string): { ts: string | null; text: string } {
  const m = STAMP_RE.exec(raw);
  return m ? { ts: m[1]!, text: raw.slice(m[0].length) } : { ts: null, text: raw };
}

/** Current time in the same format (millisecond resolution, zero padded to nanoseconds). */
export function nowStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/Z$/, '000000Z');
}
