import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { query, queryOne } from '../db/pool.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { getPublicUrl } from '../services/settings.js';
import type { UserRow } from '../services/types.js';
import type { SessionRow } from './sessions.js';

export interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  transports: string[];
  name: string;
  created_at: Date;
  last_used_at: Date | null;
}

export function toPublicPasskey(p: PasskeyRow) {
  return {
    id: p.id,
    name: p.name,
    transports: p.transports,
    createdAt: p.created_at.toISOString(),
    lastUsedAt: p.last_used_at?.toISOString() ?? null,
  };
}

async function rp(): Promise<{ rpID: string; origin: string }> {
  const url = new URL(await getPublicUrl());
  return { rpID: url.hostname, origin: url.origin };
}

async function setChallenge(sessionId: string, challenge: string): Promise<void> {
  await query('UPDATE sessions SET webauthn_challenge = $2 WHERE id = $1', [sessionId, challenge]);
}

async function takeChallenge(sessionId: string): Promise<string> {
  const r = await queryOne<{ c: string | null }>(
    `UPDATE sessions s SET webauthn_challenge = NULL FROM (SELECT webauthn_challenge AS c FROM sessions WHERE id = $1) old
     WHERE s.id = $1 RETURNING old.c`,
    [sessionId],
  );
  if (!r?.c) throw badRequest('No pending passkey challenge; request options again', 'no_challenge');
  return r.c;
}

export async function listPasskeys(userId: string): Promise<PasskeyRow[]> {
  return query<PasskeyRow>('SELECT * FROM passkeys WHERE user_id = $1 ORDER BY created_at', [userId]);
}

export async function registrationOptions(user: UserRow, session: SessionRow): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpID } = await rp();
  const existing = await listPasskeys(user.id);
  const opts = await generateRegistrationOptions({
    rpName: 'ServCrafty',
    rpID,
    userName: user.username,
    userID: new TextEncoder().encode(user.id),
    userDisplayName: user.username,
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports as AuthenticatorTransportFuture[] })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  await setChallenge(session.id, opts.challenge);
  return opts;
}

export async function verifyRegistration(
  user: UserRow,
  session: SessionRow,
  response: RegistrationResponseJSON,
  name: string,
): Promise<PasskeyRow> {
  const { rpID, origin } = await rp();
  const expectedChallenge = await takeChallenge(session.id);
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  }).catch((err: unknown) => {
    throw badRequest(`Passkey registration failed: ${(err as Error).message}`, 'passkey_invalid');
  });
  if (!v.verified || !v.registrationInfo) throw badRequest('Passkey registration could not be verified', 'passkey_invalid');
  const cred = v.registrationInfo.credential;
  const row = await queryOne<PasskeyRow>(
    `INSERT INTO passkeys (id, user_id, public_key, counter, transports, name) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO NOTHING RETURNING *`,
    [cred.id, user.id, Buffer.from(cred.publicKey), cred.counter, cred.transports ?? response.response.transports ?? [], name || 'Passkey'],
  );
  if (!row) throw badRequest('This passkey is already registered', 'passkey_exists');
  return row;
}

export async function authenticationOptions(user: UserRow, session: SessionRow): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpID } = await rp();
  const keys = await listPasskeys(user.id);
  if (!keys.length) throw badRequest('No passkeys registered', 'no_passkeys');
  const opts = await generateAuthenticationOptions({
    rpID,
    allowCredentials: keys.map((k) => ({ id: k.id, transports: k.transports as AuthenticatorTransportFuture[] })),
    userVerification: 'preferred',
  });
  await setChallenge(session.id, opts.challenge);
  return opts;
}

export async function verifyAuthentication(user: UserRow, session: SessionRow, response: AuthenticationResponseJSON): Promise<void> {
  const { rpID, origin } = await rp();
  const expectedChallenge = await takeChallenge(session.id);
  const key = await queryOne<PasskeyRow>('SELECT * FROM passkeys WHERE id = $1 AND user_id = $2', [response.id, user.id]);
  if (!key) throw unauthorized('Unknown passkey', 'passkey_invalid');
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: key.id,
      publicKey: new Uint8Array(key.public_key),
      counter: key.counter,
      transports: key.transports as AuthenticatorTransportFuture[],
    },
    requireUserVerification: false,
  }).catch((err: unknown) => {
    throw unauthorized(`Passkey verification failed: ${(err as Error).message}`, 'passkey_invalid');
  });
  if (!v.verified) throw unauthorized('Passkey verification failed', 'passkey_invalid');
  await query('UPDATE passkeys SET counter = $2, last_used_at = now() WHERE id = $1', [key.id, v.authenticationInfo.newCounter]);
}
