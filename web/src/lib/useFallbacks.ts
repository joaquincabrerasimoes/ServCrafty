import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { serversApi } from '@/api';
import { ingestStats, type LiveServer, type LogLine } from '@/ws/live';

type Live = LiveServer & { conn: string };

/** Live logs from the socket; while the socket is down, poll the REST tail instead. */
export function useLogs(serverId: string, live: Live, tail = 300): LogLine[] {
  const offline = live.conn !== 'open';
  const { data } = useQuery({
    queryKey: ['servers', serverId, 'logs', tail],
    queryFn: () => serversApi.logs(serverId, tail),
    enabled: offline,
    refetchInterval: offline ? 5000 : false,
  });
  return useMemo(() => {
    if (!offline) return live.logs;
    const rest: LogLine[] = (data ?? []).map((text, i) => ({ id: -1 - i, text, kind: 'line' }));
    // Keep locally echoed commands/errors visible alongside the polled tail.
    return rest.concat(live.logs.filter((l) => l.kind !== 'line'));
  }, [offline, live.logs, data]);
}

/** Live stats from the socket; while the socket is down, poll the REST endpoint. */
export function useStats(serverId: string, live: Live) {
  const offline = live.conn !== 'open';
  useQuery({
    queryKey: ['servers', serverId, 'stats'],
    queryFn: async () => {
      const st = await serversApi.stats(serverId);
      ingestStats(serverId, st);
      return st;
    },
    enabled: offline || !live.stats,
    refetchInterval: offline ? 3000 : false,
  });
  return live.stats;
}
