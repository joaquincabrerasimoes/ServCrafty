// Only lines that state the Minecraft version. A bare "Version: x.y.z" also matches mod/pack versions
// (e.g. "Fabulously Optimized 3.2.18"), so it is accepted for Bedrock's own banner line only.
const RE_VERSION =
  /Starting minecraft server version (\S+)|Loading Minecraft (\d[\w.+-]*) with|^\[[^\]]*\bINFO\]\s+Version:\s+(\d+(?:\.\d+){2,3})\s*$/i;

/** Minecraft version announced by a server log line, or null. */
export function detectMcVersion(line: string): string | null {
  const v = RE_VERSION.exec(line);
  return v ? (v[1] ?? v[2] ?? v[3] ?? null) : null;
}
