import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { decrypt, encrypt } from '../lib/crypto.js';

authenticator.options = { window: 1 };

export async function newTotpSecret(username: string): Promise<{ secret: string; otpauthUrl: string; qrDataUrl: string; enc: string }> {
  const secret = authenticator.generateSecret(20);
  const otpauthUrl = authenticator.keyuri(username, 'ServCrafty', secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 });
  return { secret, otpauthUrl, qrDataUrl, enc: encrypt(secret) };
}

export function verifyTotp(encSecret: string | null, code: string): boolean {
  if (!encSecret) return false;
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  try {
    return authenticator.check(clean, decrypt(encSecret));
  } catch {
    return false;
  }
}
