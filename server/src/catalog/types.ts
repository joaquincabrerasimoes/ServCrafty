export type CatalogSource = 'curseforge' | 'modrinth';
export type CatalogKind = 'modpack' | 'mod' | 'plugin';

export interface CatalogHit {
  source: CatalogSource;
  id: string;
  slug: string;
  name: string;
  summary: string;
  author: string | null;
  iconUrl: string | null;
  downloads: number;
  categories: string[];
  gameVersions: string[];
  loaders: string[];
  updatedAt: string | null;
  url: string;
}

export interface CatalogSearchResult {
  hits: CatalogHit[];
  total: number;
  offset: number;
  limit: number;
}

export interface CatalogProject extends CatalogHit {
  description: string;
  kind: CatalogKind | null;
  links: Record<string, string>;
}

export interface CatalogFile {
  fileName: string;
  url: string | null;
  size: number;
  hashes: { sha1?: string; sha512?: string };
  primary: boolean;
}

export interface CatalogVersion {
  source: CatalogSource;
  id: string;
  projectId: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  releaseType: 'release' | 'beta' | 'alpha';
  datePublished: string;
  downloads: number;
  files: CatalogFile[];
  /** Server pack file id (CurseForge), when the version has one. */
  serverPackFileId?: string | null;
}
