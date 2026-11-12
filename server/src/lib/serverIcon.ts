/** Minecraft Java shows `server-icon.png` (exactly 64x64, PNG) in the multiplayer list. */
export const SERVER_ICON_FILE = 'server-icon.png';
export const SERVER_ICON_SIZE = 64;
export const SERVER_ICON_MAX_BYTES = 256 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk, or null when the buffer is not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Empty string when the image is a valid server icon, otherwise the reason (for the error message). */
export function iconProblem(buf: Buffer): string {
  if (buf.length > SERVER_ICON_MAX_BYTES) return `The icon is larger than ${SERVER_ICON_MAX_BYTES / 1024} KB`;
  const size = pngSize(buf);
  if (!size) return 'The icon must be a PNG image';
  if (size.width !== SERVER_ICON_SIZE || size.height !== SERVER_ICON_SIZE) {
    return `The icon must be exactly ${SERVER_ICON_SIZE}x${SERVER_ICON_SIZE} pixels (it is ${size.width}x${size.height})`;
  }
  return '';
}
