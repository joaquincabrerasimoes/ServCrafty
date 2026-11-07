/** Application error carrying an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'unauthorized') =>
  new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to do that', code = 'forbidden') =>
  new AppError(403, code, message);
export const notFound = (message = 'Not found', code = 'not_found') => new AppError(404, code, message);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);
export const tooMany = (message = 'Too many requests', code = 'rate_limited') => new AppError(429, code, message);
export const unavailable = (message: string, code = 'unavailable') => new AppError(503, code, message);
export const upstream = (message: string, code = 'upstream_error') => new AppError(502, code, message);

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
