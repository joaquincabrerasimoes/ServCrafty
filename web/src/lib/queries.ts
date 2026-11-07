import { useQuery } from '@tanstack/react-query';
import { serversApi } from '@/api';

export const qk = {
  servers: ['servers'] as const,
  server: (id: string) => ['servers', id] as const,
  serverSub: (id: string, sub: string, ...rest: unknown[]) => ['servers', id, sub, ...rest] as const,
  me: ['me'] as const,
  quota: ['quota'] as const,
  templates: ['templates'] as const,
};

export function useServers() {
  return useQuery({ queryKey: qk.servers, queryFn: serversApi.list, refetchInterval: 10_000 });
}

export function useServer(id: string) {
  return useQuery({ queryKey: qk.server(id), queryFn: () => serversApi.get(id), refetchInterval: 15_000 });
}
