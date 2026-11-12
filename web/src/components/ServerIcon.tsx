import clsx from 'clsx';
import { serversApi } from '@/api';
import type { Server } from '@/api/types';

/** The multiplayer-list icon of a Java server; renders nothing when the server has none. */
export function ServerIcon({ server, className }: { server: Pick<Server, 'id' | 'icon' | 'name'>; className?: string }) {
  if (server.icon == null) return null;
  return (
    <img
      src={serversApi.iconUrl(server.id, server.icon)}
      alt=""
      width={64}
      height={64}
      loading="lazy"
      className={clsx('shrink-0 rounded-[3px] bg-raised [image-rendering:pixelated]', className)}
    />
  );
}
