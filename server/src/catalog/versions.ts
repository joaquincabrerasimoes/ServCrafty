import { badRequest } from '../lib/errors.js';
import { fetchJson, TtlCache } from '../lib/http.js';
import type { ServerType } from '../lib/validation.js';

const cache = new TtlCache<string[]>(30 * 60_000);

async function vanilla(includeSnapshots: boolean): Promise<string[]> {
  const r = await fetchJson<{ versions: { id: string; type: string }[] }>(
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  );
  return r.versions.filter((v) => v.type === 'release' || (includeSnapshots && v.type === 'snapshot')).map((v) => v.id);
}

async function paperLike(project: 'paper' | 'folia'): Promise<string[]> {
  try {
    const r = await fetchJson<{ versions: Record<string, string[]> }>(`https://fill.papermc.io/v3/projects/${project}`);
    return Object.values(r.versions)
      .flat()
      .filter((v) => !/-(pre|rc)/i.test(v));
  } catch {
    const r = await fetchJson<{ versions: string[] }>(`https://api.papermc.io/v2/projects/${project}`);
    return [...r.versions].reverse();
  }
}

function sortDesc(vs: string[]): string[] {
  const key = (v: string) => v.split(/[.\-+]/).map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
  return [...new Set(vs)].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (kb[i] ?? 0) - (ka[i] ?? 0);
      if (d) return d;
    }
    return 0;
  });
}

/** NeoForge version "21.1.77" targets MC 1.21.1; "20.4.x" -> 1.20.4; "21.0.x" -> 1.21; year-based "26.1.x" -> 26.1. */
export function neoforgeToMc(v: string): string | null {
  const m = /^(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major >= 26) return minor === 0 ? `${major}` : `${major}.${minor}`;
  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
}

/** Minecraft versions available for a server type (newest first). */
export async function minecraftVersions(type: ServerType, includeSnapshots = false): Promise<string[]> {
  return cache.get(`${type}:${includeSnapshots}`, async () => {
    switch (type) {
      case 'VANILLA':
      // Spigot and CraftBukkit are built for release versions of Minecraft.
      case 'SPIGOT':
      case 'BUKKIT':
      case 'CURSEFORGE':
      case 'MODRINTH':
        return vanilla(includeSnapshots);
      case 'PAPER':
        return paperLike('paper');
      case 'FOLIA':
        return paperLike('folia');
      case 'PURPUR': {
        const r = await fetchJson<{ versions: string[] }>('https://api.purpurmc.org/v2/purpur');
        return [...r.versions].reverse();
      }
      case 'FABRIC': {
        const r = await fetchJson<{ version: string; stable: boolean }[]>('https://meta.fabricmc.net/v2/versions/game');
        return r.filter((v) => includeSnapshots || v.stable).map((v) => v.version);
      }
      case 'QUILT': {
        const r = await fetchJson<{ version: string; stable: boolean }[]>('https://meta.quiltmc.org/v3/versions/game');
        return r.filter((v) => includeSnapshots || v.stable).map((v) => v.version);
      }
      case 'FORGE': {
        const r = await fetchJson<{ promos: Record<string, string> }>(
          'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
        );
        return sortDesc(Object.keys(r.promos).map((k) => k.replace(/-(latest|recommended)$/, '')));
      }
      case 'NEOFORGE': {
        const r = await fetchJson<{ versions: string[] }>(
          'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge',
        );
        return sortDesc(r.versions.map(neoforgeToMc).filter((v): v is string => !!v));
      }
      case 'BEDROCK':
        return ['LATEST', 'PREVIEW'];
      default:
        throw badRequest('Unknown server type');
    }
  });
}

/** Loader versions for a type/MC version (newest first). Empty for types without a separate loader. */
export async function loaderVersions(type: ServerType, mcVersion: string): Promise<string[]> {
  return cache.get(`loader:${type}:${mcVersion}`, async () => {
    switch (type) {
      case 'FABRIC': {
        const r = await fetchJson<{ loader: { version: string; stable: boolean } }[]>(
          `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`,
        );
        return r.map((x) => x.loader.version);
      }
      case 'QUILT': {
        const r = await fetchJson<{ loader: { version: string } }[]>(
          `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mcVersion)}`,
        );
        return r.map((x) => x.loader.version);
      }
      case 'FORGE': {
        const r = await fetchJson<{ promos: Record<string, string> }>(
          'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
        );
        return [r.promos[`${mcVersion}-recommended`], r.promos[`${mcVersion}-latest`]].filter(
          (v, i, a): v is string => !!v && a.indexOf(v) === i,
        );
      }
      case 'NEOFORGE': {
        const r = await fetchJson<{ versions: string[] }>(
          'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge',
        );
        return r.versions.filter((v) => neoforgeToMc(v) === mcVersion).reverse();
      }
      case 'PAPER':
      case 'FOLIA': {
        const project = type === 'PAPER' ? 'paper' : 'folia';
        const r = await fetchJson<{ builds: number[] }>(
          `https://api.papermc.io/v2/projects/${project}/versions/${encodeURIComponent(mcVersion)}`,
        ).catch(() => ({ builds: [] as number[] }));
        return r.builds.map(String).reverse();
      }
      case 'PURPUR': {
        const r = await fetchJson<{ builds: { all: string[] } }>(
          `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(mcVersion)}`,
        ).catch(() => ({ builds: { all: [] as string[] } }));
        return [...r.builds.all].reverse();
      }
      default:
        return [];
    }
  });
}
