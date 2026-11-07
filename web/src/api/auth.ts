import { api, asList, normalizeUser } from './client';
import type {
  ApiToken,
  LoginResponse,
  MeResponse,
  Passkey,
  QuotaResponse,
  ThemePref,
  Locale,
  TotpSetup,
  User,
} from './types';

type OkUser = { status: 'ok'; user: User };

/** Some servers wrap WebAuthn options as {options: ...}; accept both. */
function unwrapOptions<T>(x: unknown): T {
  const o = x as Record<string, unknown>;
  return (o && typeof o === 'object' && 'options' in o ? o.options : o) as T;
}

export const authApi = {
  login: async (username: string, password: string) => {
    const r = await api.post<LoginResponse>('/auth/login', { username, password });
    return r.status === 'ok' ? { ...r, user: normalizeUser(r.user) } : r;
  },
  totp: async (code: string) => {
    const r = await api.post<OkUser>('/auth/mfa/totp', { code });
    return { ...r, user: normalizeUser(r.user) };
  },
  passkeyOptions: async () => unwrapOptions<Record<string, unknown>>(await api.post('/auth/mfa/passkey/options')),
  passkeyVerify: async (response: unknown) => {
    const r = await api.post<OkUser>('/auth/mfa/passkey/verify', { response });
    return { ...r, user: normalizeUser(r.user) };
  },
  logout: () => api.post<void>('/auth/logout'),
  me: async () => {
    const r = await api.get<MeResponse>('/auth/me');
    return { ...r, user: normalizeUser(r.user) };
  },
};

export const accountApi = {
  changePassword: (current: string, next: string) => api.post<void>('/account/password', { current, new: next }),
  update: async (body: { email?: string | null; locale?: Locale; theme?: ThemePref }) => {
    const r = await api.patch<{ user: User }>('/account', body);
    return r?.user ? normalizeUser(r.user) : undefined;
  },
  quota: () => api.get<QuotaResponse>('/account/quota'),

  totpSetup: () => api.post<TotpSetup>('/account/totp/setup'),
  totpEnable: (code: string) => api.post<void>('/account/totp/enable', { code }),
  totpDisable: (password: string) => api.post<void>('/account/totp/disable', { password }),

  passkeyOptions: async () => unwrapOptions<Record<string, unknown>>(await api.post('/account/passkeys/options')),
  passkeyVerify: async (response: unknown, name: string) => {
    const r = await api.post<{ passkey: Passkey }>('/account/passkeys/verify', { response, name });
    return r.passkey;
  },
  passkeys: async () => asList<Passkey>(await api.get('/account/passkeys'), 'passkeys'),
  deletePasskey: (id: string) => api.del<void>(`/account/passkeys/${encodeURIComponent(id)}`),

  tokens: async () => asList<ApiToken>(await api.get('/account/tokens'), 'tokens'),
  createToken: (name: string, expiresAt?: string) => api.post<ApiToken>('/account/tokens', { name, expiresAt }),
  deleteToken: (id: string) => api.del<void>(`/account/tokens/${id}`),
};
