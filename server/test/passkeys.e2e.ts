/**
 * End-to-end passkey ceremony against a RUNNING server using a software
 * authenticator (ES256, "none" attestation). Not part of `npm test`.
 *
 *   SC_BASE=http://localhost:8080 SC_ORIGIN=http://localhost:5173 \
 *   SC_USER=admin SC_PASS=... npx tsx test/passkeys.e2e.ts
 *
 * SC_ORIGIN must equal the origin of the server's effective PUBLIC_URL.
 * The account must have no TOTP and no passkeys. Creates one passkey and
 * deletes it again.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import test from 'node:test';

const BASE = process.env.SC_BASE ?? 'http://localhost:8080';
const ORIGIN = process.env.SC_ORIGIN ?? 'http://localhost:5173';
const USER = process.env.SC_USER ?? 'admin';
const PASS = process.env.SC_PASS ?? '';
const RPID = new URL(ORIGIN).hostname;

// ---- minimal CBOR + software authenticator ----
const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
}
type Cbor = number | string | Buffer | Map<Cbor, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

interface AssertOpts { origin?: string; rpId?: string; counter?: number; flags?: number }

class SoftAuthenticator {
  readonly credId = randomBytes(32);
  counter = 0;
  private priv: KeyObject;
  private pub: KeyObject;
  constructor() {
    const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.priv = kp.privateKey;
    this.pub = kp.publicKey;
  }
  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
  register(opts: { challenge: string }, o: AssertOpts = {}) {
    const jwk = this.pub.export({ format: 'jwk' });
    const cose = cbor(new Map<Cbor, Cbor>([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')],
    ]));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credId.length);
    const cnt = Buffer.alloc(4);
    cnt.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(o.rpId ?? RPID), Buffer.from([UP | UV | AT]), cnt, Buffer.alloc(16), len, this.credId, cose]);
    const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', opts.challenge, o.origin ?? ORIGIN)),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
    };
  }
  /** Signed assertion. Without o.counter the authenticator counter is incremented first. */
  assert(opts: { challenge: string }, o: AssertOpts = {}) {
    if (o.counter === undefined) this.counter += 1;
    const cnt = Buffer.alloc(4);
    cnt.writeUInt32BE(o.counter ?? this.counter);
    const authData = Buffer.concat([sha256(o.rpId ?? RPID), Buffer.from([o.flags ?? UP | UV]), cnt]);
    const cd = this.clientData('webauthn.get', opts.challenge, o.origin ?? ORIGIN);
    const signature = sign('sha256', Buffer.concat([authData, sha256(cd)]), this.priv);
    return {
      id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature) },
    };
  }
}

// ---- HTTP client with a one-cookie jar ----
class Client {
  cookie = '';
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0]!;
      this.cookie = kv.endsWith('=') ? '' : kv;
    }
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }
}

test('passkey registration, MFA login, replay/origin/rpId rejection, delete', async (t) => {
  assert.ok(PASS, 'set SC_PASS');
  const auth = new SoftAuthenticator();
  const c = new Client();
  let pkId = '';

  /** Password login that must yield mfa_required(passkey); returns the assertion options. */
  const loginMfa = async (cl: Client) => {
    const r = await cl.req('POST', '/auth/login', { username: USER, password: PASS });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'mfa_required');
    assert.ok(r.json.methods.includes('passkey'));
    const o = await cl.req('POST', '/auth/mfa/passkey/options');
    assert.equal(o.status, 200);
    return o.json as { challenge: string; rpId: string };
  };
  const passkeyLogin = async (cl: Client, o: AssertOpts = {}) => {
    const opts = await loginMfa(cl);
    return cl.req('POST', '/auth/mfa/passkey/verify', { response: auth.assert(opts, o) });
  };

  await t.test('register (bad origin / bad rpId rejected, good accepted)', async () => {
    const l = await c.req('POST', '/auth/login', { username: USER, password: PASS });
    assert.equal(l.status, 200);
    assert.equal(l.json.status, 'ok', 'test account must have no TOTP and no passkeys');
    const o = await c.req('POST', '/account/passkeys/options');
    assert.equal(o.status, 200);
    assert.equal(o.json.rp.id, RPID, 'server rpId must match the SC_ORIGIN host');
    let bad = await c.req('POST', '/account/passkeys/verify', { response: auth.register(o.json, { origin: 'https://evil.example' }), name: 'sw' });
    assert.equal(bad.status, 400);
    const o2 = await c.req('POST', '/account/passkeys/options');
    bad = await c.req('POST', '/account/passkeys/verify', { response: auth.register(o2.json, { rpId: 'evil.example' }), name: 'sw' });
    assert.equal(bad.status, 400, 'wrong rpIdHash must be rejected');
    const o3 = await c.req('POST', '/account/passkeys/options');
    const ok = await c.req('POST', '/account/passkeys/verify', { response: auth.register(o3.json), name: 'software-test' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    pkId = ok.json.passkey.id;
    const list = await c.req('GET', '/account/passkeys');
    assert.ok(list.json.some((p: { id: string }) => p.id === pkId));
    await c.req('POST', '/auth/logout');
  });

  try {
    await t.test('passkey login works; replay and counter regression rejected', async () => {
      const cl = new Client();
      const opts = await loginMfa(cl);
      assert.equal(opts.rpId, RPID);
      const assertion = auth.assert(opts); // counter 1
      const v = await cl.req('POST', '/auth/mfa/passkey/verify', { response: assertion });
      assert.equal(v.status, 200, JSON.stringify(v.json));
      assert.equal(v.json.status, 'ok');
      assert.equal((await cl.req('GET', '/auth/me')).status, 200);
      await cl.req('POST', '/auth/logout');

      // replay of the very same assertion in a fresh login (stale challenge)
      const cl2 = new Client();
      await loginMfa(cl2);
      assert.equal((await cl2.req('POST', '/auth/mfa/passkey/verify', { response: assertion })).status, 401);
      assert.equal((await cl2.req('GET', '/auth/me')).status, 401);

      // second legitimate login: counter 2
      assert.equal((await passkeyLogin(new Client())).status, 200);
      // correct challenge, valid signature, but counter regressed to 1
      assert.equal((await passkeyLogin(new Client(), { counter: 1 })).status, 401, 'counter regression must be rejected');
      // equal counter (2) is also a clone signal
      assert.equal((await passkeyLogin(new Client(), { counter: 2 })).status, 401, 'repeated counter must be rejected');
      // and a later counter still works afterwards
      auth.counter = 5;
      assert.equal((await passkeyLogin(new Client(), { counter: 6 })).status, 200);
    });

    await t.test('wrong origin / rpId / UP flag / unknown credential rejected', async () => {
      for (const o of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { flags: 0 }]) {
        const cl = new Client();
        const r = await passkeyLogin(cl, { counter: 100, ...o });
        assert.equal(r.status, 401, JSON.stringify(o));
        assert.equal((await cl.req('GET', '/account/passkeys')).status, 401, 'pending session must not reach the API');
      }
      const cl = new Client();
      const opts = await loginMfa(cl);
      assert.equal((await cl.req('POST', '/auth/mfa/passkey/verify', { response: new SoftAuthenticator().assert(opts) })).status, 401);
    });
  } finally {
    await t.test('delete passkey', async () => {
      const cl = new Client();
      const v = await passkeyLogin(cl, { counter: 200 });
      assert.equal(v.status, 200, JSON.stringify(v.json));
      assert.equal((await cl.req('DELETE', `/account/passkeys/${pkId}`)).status, 200);
      assert.equal((await cl.req('GET', '/account/passkeys')).json.length, 0);
      await cl.req('POST', '/auth/logout');
    });
  }
});
