import { api, asList } from './client';
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
  login: (username: string, password: string) => api.post<LoginResponse>('/auth/login', { username, password }),
  totp: (code: string) => api.post<OkUser>('/auth/mfa/totp', { code }),
  passkeyOptions: async () => unwrapOptions<Record<string, unknown>>(await api.post('/auth/mfa/passkey/options')),
  passkeyVerify: (response: unknown) => api.post<OkUser>('/auth/mfa/passkey/verify', { response }),
  logout: () => api.post<void>('/auth/logout'),
  me: () => api.get<MeResponse>('/auth/me'),
};

export const accountApi = {
  changePassword: (current: string, next: string) => api.post<void>('/account/password', { current, new: next }),
  update: (body: { email?: string | null; locale?: Locale; theme?: ThemePref }) => api.patch<User | void>('/account', body),
  quota: () => api.get<QuotaResponse>('/account/quota'),

  totpSetup: () => api.post<TotpSetup>('/account/totp/setup'),
  totpEnable: (code: string) => api.post<void>('/account/totp/enable', { code }),
  totpDisable: (password: string) => api.post<void>('/account/totp/disable', { password }),

  passkeyOptions: async () => unwrapOptions<Record<string, unknown>>(await api.post('/account/passkeys/options')),
  passkeyVerify: (response: unknown, name: string) => api.post<Passkey>('/account/passkeys/verify', { response, name }),
  passkeys: async () => asList<Passkey>(await api.get('/account/passkeys'), 'passkeys'),
  deletePasskey: (id: string) => api.del<void>(`/account/passkeys/${encodeURIComponent(id)}`),

  tokens: async () => asList<ApiToken>(await api.get('/account/tokens'), 'tokens'),
  createToken: (name: string, expiresAt?: string) => api.post<ApiToken>('/account/tokens', { name, expiresAt }),
  deleteToken: (id: string) => api.del<void>(`/account/tokens/${id}`),
};
