import { ApiError, buildUrl } from './client';

export type DocKind = 'guide' | 'openapi';

const DOCS: Record<DocKind, { path: string; fallback: string; accept: string }> = {
  guide: { path: '/docs/api-tokens.md', fallback: 'servcrafty-api-tokens.md', accept: 'text/markdown, text/plain, */*' },
  openapi: { path: '/docs/openapi.json', fallback: 'servcrafty-openapi.json', accept: 'application/json, */*' },
};

/** The file name of a Content-Disposition header (RFC 6266 `filename*` first, then `filename`). */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star?.[2]) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain parameter */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const name = (plain?.[2] ?? plain?.[1] ?? '').trim();
  // Never let a header pick a path.
  return name ? name.replace(/[\\/]/g, '_') : null;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const docsApi = {
  /** Fetches an API documentation file with the session cookie and saves it. */
  download: async (kind: DocKind) => {
    const doc = DOCS[kind];
    let res: Response;
    try {
      res = await fetch(buildUrl(doc.path), { credentials: 'same-origin', headers: { Accept: doc.accept } });
    } catch {
      throw new ApiError(0, 'network_error', 'Cannot reach the ServCrafty server.');
    }
    if (!res.ok) {
      let message = res.statusText || 'Request failed';
      let code = `http_${res.status}`;
      try {
        const data = await res.json();
        code = data?.error?.code ?? code;
        message = data?.error?.message ?? message;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, code, message);
    }
    const blob = await res.blob();
    saveBlob(blob, filenameFromDisposition(res.headers.get('Content-Disposition')) ?? doc.fallback);
  },
};
