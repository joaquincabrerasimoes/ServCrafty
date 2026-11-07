import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { queryOne } from '../db/pool.js';
import { decrypt, encrypt } from '../lib/crypto.js';

const TOTP_STEP_SEC = 30;
authenticator.options = { window: 1, step: TOTP_STEP_SEC };

export async function newTotpSecret(username: string): Promise<{ secret: string; otpauthUrl: string; qrDataUrl: string; enc: string }> {
  const secret = authenticator.generateSecret(20);
  const otpauthUrl = authenticator.keyuri(username, 'ServCrafty', secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 });
  return { secret, otpauthUrl, qrDataUrl, enc: encrypt(secret) };
}

/**
 * Verify a TOTP code and, if valid, atomically record its time step so the same
 * (or an older) code can never be accepted again. Returns false on replay.
 */
export async function consumeTotp(userId: string, encSecret: string | null, code: string): Promise<boolean> {
  if (!encSecret) return false;
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  let delta: number | null;
  try {
    delta = authenticator.checkDelta(clean, decrypt(encSecret));
  } catch {
    return false;
  }
  if (delta === null) return false;
  const step = Math.floor(Date.now() / 1000 / TOTP_STEP_SEC) + delta;
  const row = await queryOne(
    'UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id',
    [userId, step],
  );
  return !!row;
}
