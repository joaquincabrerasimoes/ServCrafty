import { z, type ZodTypeAny } from 'zod';
import { AppError } from './errors.js';

/** Parse `input` with `schema`, throwing a 400 AppError with issue details on failure. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first && first.path.length ? `${first.path.join('.')}: ` : '';
    throw new AppError(400, 'validation_error', `${where}${first?.message ?? 'Invalid input'}`, r.error.issues);
  }
  return r.data;
}

export const idParam = z.object({ id: z.string().uuid() });
export const uuid = z.string().uuid();

/** Optional nullable non-negative quota values. */
export const quotaInt = z.number().int().min(0).nullable().optional();
export const quotaNum = z.number().min(0).nullable().optional();

export const serverTypes = [
  'VANILLA',
  'PAPER',
  'PURPUR',
  'FOLIA',
  'SPIGOT',
  'BUKKIT',
  'FABRIC',
  'QUILT',
  'FORGE',
  'NEOFORGE',
  'BEDROCK',
  'CURSEFORGE',
  'MODRINTH',
] as const;
export type ServerType = (typeof serverTypes)[number];
export const serverTypeSchema = z.enum(serverTypes);

/** Clamp a query-string integer. */
export function intQuery(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
