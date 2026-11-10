import { useState } from 'react';
import clsx from 'clsx';
import { Gamepad2 } from 'lucide-react';
import type { GamePort, Server } from '@/api/types';
import { useT } from '@/i18n';
import { gameName, mainPortOf, protocolLabel, publishedPorts, useGameDefs } from '@/lib/gameDefs';
import { serverGame } from '@/lib/games';
import { Badge } from './ui';

/** A game definition's icon (any https URL), or a gamepad when there is none or it fails to load. */
export function GameIcon({ src, className, active }: { src?: string | null; className?: string; active?: boolean }) {
  const [broken, setBroken] = useState(false);
  const cls = clsx('flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-block', className);
  if (src && !broken)
    return (
      <span className={clsx(cls, 'bg-raised')}>
        <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" onError={() => setBroken(true)} />
      </span>
    );
  return (
    <span className={clsx(cls, active ? 'bg-accent text-accent-ink' : 'bg-raised text-muted')}>
      <Gamepad2 className="h-6 w-6" aria-hidden="true" />
    </span>
  );
}

/** Badge with the game a server runs; SteamCMD servers show their definition's name. */
export function GameBadge({ server }: { server: Server }) {
  const t = useT();
  const steam = serverGame(server) === 'steam';
  const defs = useGameDefs(steam);
  return <Badge tone={serverGame(server) === 'minecraft' ? 'neutral' : 'accent'}>{gameName(server, defs.data, t)}</Badge>;
}

export interface HostPort {
  id: string;
  label: string;
  /** null while the definition is unknown. */
  protocol: GamePort['protocol'] | null;
  containerPort?: number;
  /** null when it is not known yet (before creation) or not published. */
  hostPort: number | null;
  main: boolean;
}

/** Ports of a SteamCMD server: the main one (servers.port) first, then `extraPorts`. */
export function serverPorts(server: Pick<Server, 'port' | 'extraPorts'>, def: { ports?: GamePort[] } | undefined, mainLabel: string): HostPort[] {
  const main = mainPortOf(def);
  const out: HostPort[] = [
    { id: main?.id ?? 'main', label: main?.label || mainLabel, protocol: main?.protocol ?? null, containerPort: main?.containerPort, hostPort: server.port, main: true },
  ];
  const extra = server.extraPorts ?? {};
  const known = new Set<string>([out[0]!.id]);
  for (const p of publishedPorts(def)) {
    if (known.has(p.id)) continue;
    known.add(p.id);
    out.push({ id: p.id, label: p.label || p.id, protocol: p.protocol, containerPort: p.containerPort, hostPort: extra[p.id] ?? null, main: false });
  }
  for (const [id, port] of Object.entries(extra)) {
    if (known.has(id)) continue;
    out.push({ id, label: id, protocol: null, hostPort: port, main: false });
  }
  return out;
}

export { protocolLabel };
