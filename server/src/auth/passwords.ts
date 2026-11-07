import { hash, verify } from '@node-rs/argon2';

// argon2id (Algorithm.Argon2id = 2) with OWASP-recommended parameters.
const OPTS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

/** A real hash used to equalize timing for unknown usernames. */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  if (!dummy) dummy = hashPassword('servcrafty-timing-equalizer');
  return dummy;
}

export const PASSWORD_MIN = 8;
