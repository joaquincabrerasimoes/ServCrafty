/** Thin fetch wrapper for the ServCrafty REST API (prefix /api, cookie session). */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

const BASE = '/api';
let unauthorizedHandler: (() => void) | null = null;

/** Called whenever the API answers 401 (e.g. session expired). */
export function onUnauthorized(fn: () => void) {
  unauthorizedHandler = fn;
}

export function buildUrl(path: string, query?: Query): string {
  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
  }
  const s = qs.toString();
  return `${BASE}${path}${s ? `?${s}` : ''}`;
}

async function parseError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = res.statusText || 'Request failed';
  try {
    const data = await res.json();
    if (data?.error) {
      code = data.error.code ?? code;
      message = data.error.message ?? message;
    } else if (typeof data?.message === 'string') {
      message = data.message;
    }
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, code, message);
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network_error', 'Cannot reach the ServCrafty server.');
  }
  if (!res.ok) {
    const err = await parseError(res);
    if (res.status === 401 && !path.startsWith('/auth/')) unauthorizedHandler?.();
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * Multipart POST with upload progress (fetch cannot report it). Same error and 401 handling as
 * `request`. `onProgress` receives a fraction between 0 and 1.
 */
export function uploadWithProgress<T>(path: string, form: FormData, opts: { query?: Query; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', buildUrl(path, opts.query));
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Cannot reach the ServCrafty server.'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    xhr.onload = () => {
      const text = xhr.responseText;
      let data: unknown = undefined;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T);
        return;
      }
      const d = data as { error?: { code?: string; message?: string }; message?: unknown } | undefined;
      const code = d?.error?.code ?? `http_${xhr.status}`;
      const message = d?.error?.message ?? (typeof d?.message === 'string' ? d.message : xhr.statusText || 'Request failed');
      if (xhr.status === 401) unauthorizedHandler?.();
      reject(new ApiError(xhr.status, code, message));
    };
    opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown, query?: Query) => request<T>('POST', path, { body: body ?? {}, query }),
  put: <T>(path: string, body?: unknown, query?: Query) => request<T>('PUT', path, { body, query }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  del: <T>(path: string, query?: Query) => request<T>('DELETE', path, { query }),
  upload: <T>(path: string, form: FormData, query?: Query) => request<T>('POST', path, { body: form, query }),
};

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

/** The API nests quotas under `quotas`; the UI uses flat max* fields. Also coerces numeric strings. */
export function normalizeUser<T extends object>(u: T): T {
  const r = u as Record<string, unknown>;
  const q = (r.quotas ?? r) as Record<string, unknown>;
  return {
    ...r,
    maxServers: num(q.maxServers),
    maxRamMb: num(q.maxRamMb),
    maxCpu: num(q.maxCpu),
    maxDiskMb: num(q.maxDiskMb),
  } as T;
}

/** Accepts either a bare array or a wrapper object ({items}, {data}, ...). */
export function asList<T>(x: unknown, ...keys: string[]): T[] {
  if (Array.isArray(x)) return x as T[];
  if (x && typeof x === 'object') {
    for (const k of [...keys, 'items', 'data', 'results', 'hits', 'list']) {
      const v = (x as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

/** Triggers a browser download for a GET endpoint (cookie-authenticated). */
export function downloadUrl(path: string, query?: Query): string {
  return buildUrl(path, query);
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
